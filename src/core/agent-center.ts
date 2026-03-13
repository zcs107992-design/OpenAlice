/**
 * AgentCenter — centralized AI agent orchestration.
 *
 * Owns the GenerateRouter and manages the full session pipeline:
 *   appendUser → compact → build input → call provider.generate() → pipeline → persist → done
 *
 * Providers are slim data-source adapters; all shared logic lives here:
 *   - Session management (append, compact, read active)
 *   - Input format dispatch (text vs messages based on provider.inputKind)
 *   - Unified pipeline (logToolCall, stripImageData, extractMedia)
 *   - Message persistence (intermediate tool messages + final response)
 */

import type { AskOptions, ProviderResult, ProviderEvent, GenerateOpts } from './ai-provider.js'
import { GenerateRouter, StreamableResult } from './ai-provider.js'
import type { SessionStore, ContentBlock } from './session.js'
import { toTextHistory, toModelMessages } from './session.js'
import type { CompactionConfig } from './compaction.js'
import { compactIfNeeded } from './compaction.js'
import type { MediaAttachment } from './types.js'
import { extractMediaFromToolResultContent } from './media.js'
import { logToolCall } from '../ai-providers/log-tool-call.js'
import { stripImageData, buildChatHistoryPrompt, DEFAULT_MAX_HISTORY } from './provider-utils.js'

// ==================== Types ====================

export interface AgentCenterOpts {
  router: GenerateRouter
  compaction: CompactionConfig
  /** Default history preamble for text-based providers. */
  historyPreamble?: string
  /** Default max history entries for text-based providers. */
  maxHistoryEntries?: number
}

/** Tag used when persisting messages to session. */
type ProviderTag = 'vercel-ai' | 'claude-code' | 'agent-sdk'

// ==================== AgentCenter ====================

export class AgentCenter {
  private router: GenerateRouter
  private compaction: CompactionConfig
  private defaultPreamble?: string
  private defaultMaxHistory: number

  constructor(opts: AgentCenterOpts) {
    this.router = opts.router
    this.compaction = opts.compaction
    this.defaultPreamble = opts.historyPreamble
    this.defaultMaxHistory = opts.maxHistoryEntries ?? DEFAULT_MAX_HISTORY
  }

  /** Stateless prompt — routed through the configured AI provider. */
  async ask(prompt: string): Promise<ProviderResult> {
    return this.router.ask(prompt)
  }

  /** Prompt with session history — full orchestration pipeline. */
  askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): StreamableResult {
    return new StreamableResult(this._generate(prompt, session, opts))
  }

  // ==================== Pipeline ====================

  private async *_generate(
    prompt: string,
    session: SessionStore,
    opts?: AskOptions,
  ): AsyncGenerator<ProviderEvent> {
    const maxHistory = opts?.maxHistoryEntries ?? this.defaultMaxHistory
    const preamble = opts?.historyPreamble ?? this.defaultPreamble

    // 1. Append user message to session
    await session.appendUser(prompt, 'human')

    // 2. Resolve provider (may be overridden per-request)
    const provider = await this.router.resolve(opts?.provider)

    // 3. Compact if needed (provider can override with custom strategy)
    const compactionResult = provider.compact
      ? await provider.compact(session, this.compaction)
      : await compactIfNeeded(
          session,
          this.compaction,
          async (summarizePrompt) => (await provider.ask(summarizePrompt)).text,
        )

    // 4. Read active window
    const entries = compactionResult.activeEntries ?? await session.readActive()

    // 5. Build input based on provider.inputKind
    const genOpts: GenerateOpts = {
      disabledTools: opts?.disabledTools,
      vercelAiSdk: opts?.vercelAiSdk,
      agentSdk: opts?.agentSdk,
    }

    let source: AsyncIterable<ProviderEvent>
    if (provider.inputKind === 'text') {
      const textHistory = toTextHistory(entries).slice(-maxHistory)
      const fullPrompt = buildChatHistoryPrompt(prompt, textHistory, preamble)
      source = provider.generate(
        { kind: 'text', prompt: fullPrompt, systemPrompt: opts?.systemPrompt },
        genOpts,
      )
    } else {
      const messages = toModelMessages(entries)
      source = provider.generate(
        { kind: 'messages', messages, systemPrompt: opts?.systemPrompt },
        genOpts,
      )
    }

    // 6. Consume provider events — unified pipeline
    const media: MediaAttachment[] = []
    const intermediateMessages: Array<{ role: 'assistant' | 'user'; content: ContentBlock[] }> = []
    let currentAssistantBlocks: ContentBlock[] = []
    let currentUserBlocks: ContentBlock[] = []
    let finalResult: ProviderResult | null = null

    for await (const event of source) {
      switch (event.type) {
        case 'tool_use':
          // Unified logging — all providers get this now
          logToolCall(event.name, event.input)
          currentAssistantBlocks.push({
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: event.input,
          })
          yield event
          break

        case 'tool_result': {
          // Unified media extraction + image stripping
          media.push(...extractMediaFromToolResultContent(event.content))
          const sessionContent = stripImageData(event.content)
          currentUserBlocks.push({
            type: 'tool_result',
            tool_use_id: event.tool_use_id,
            content: sessionContent,
          })

          // Flush assistant blocks before user blocks (tool_use → tool_result)
          if (currentAssistantBlocks.length > 0) {
            intermediateMessages.push({ role: 'assistant', content: currentAssistantBlocks })
            currentAssistantBlocks = []
          }
          if (currentUserBlocks.length > 0) {
            intermediateMessages.push({ role: 'user', content: currentUserBlocks })
            currentUserBlocks = []
          }
          yield event
          break
        }

        case 'text':
          currentAssistantBlocks.push({ type: 'text', text: event.text })
          yield event
          break

        case 'done':
          finalResult = event.result
          break
      }
    }

    // Flush any remaining intermediate blocks
    if (currentAssistantBlocks.length > 0) {
      intermediateMessages.push({ role: 'assistant', content: currentAssistantBlocks })
    }
    if (currentUserBlocks.length > 0) {
      intermediateMessages.push({ role: 'user', content: currentUserBlocks })
    }

    // 7. Persist intermediate messages to session
    const providerTag = this.resolveProviderTag(provider)
    for (const msg of intermediateMessages) {
      if (msg.role === 'assistant') {
        await session.appendAssistant(msg.content, providerTag)
      } else {
        await session.appendUser(msg.content, providerTag)
      }
    }

    // 8. Persist final response text
    if (!finalResult) throw new Error('AgentCenter: provider stream ended without done event')
    await session.appendAssistant(finalResult.text, providerTag)

    // 9. Yield done with merged media
    yield {
      type: 'done',
      result: {
        text: finalResult.text,
        media: [...finalResult.media, ...media],
      },
    }
  }

  /** Determine the session provider tag based on the provider's inputKind. */
  private resolveProviderTag(provider: { inputKind: string }): ProviderTag {
    // GenerateRouter stores the original provider references, so we can't
    // introspect the class name. Use inputKind as a heuristic — text-based
    // providers are Claude Code or Agent SDK, messages-based is Vercel.
    // This is good enough; the tag is purely for session log provenance.
    return provider.inputKind === 'messages' ? 'vercel-ai' : 'claude-code'
  }
}
