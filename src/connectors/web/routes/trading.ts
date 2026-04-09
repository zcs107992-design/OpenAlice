import { Hono } from 'hono'
import type { Context } from 'hono'
import type { EngineContext } from '../../../core/types.js'
import { BrokerError } from '../../../domain/trading/brokers/types.js'
import type { UnifiedTradingAccount } from '../../../domain/trading/UnifiedTradingAccount.js'

/** Resolve account by :id param, return 404 if not found. */
function resolveAccount(ctx: EngineContext, c: Context): UnifiedTradingAccount | null {
  const id = c.req.param('id')
  if (!id) return null
  return ctx.accountManager.get(id) ?? null
}

/**
 * Execute a data query against a UTA with health-aware error handling.
 * - Offline → 503 + nudge recovery
 * - Transient error → 503
 * - Permanent error → 500
 */
async function queryAccount<T>(
  c: Context,
  account: UnifiedTradingAccount,
  fn: () => Promise<T>,
): Promise<Response> {
  if (account.health === 'offline') {
    account.nudgeRecovery()
    return c.json({
      error: 'Account temporarily unavailable',
      health: account.getHealthInfo(),
    }, 503)
  }
  try {
    return c.json(await fn())
  } catch (err) {
    const be = err instanceof BrokerError ? err : BrokerError.from(err)
    return c.json({
      error: be.message,
      code: be.code,
      transient: !be.permanent,
    }, be.permanent ? 500 : 503)
  }
}

/** Unified trading routes — works with all account types via AccountManager */
export function createTradingRoutes(ctx: EngineContext) {
  const app = new Hono()

  // ==================== Accounts listing ====================

  app.get('/accounts', (c) => {
    return c.json({ accounts: ctx.accountManager.listAccounts() })
  })

  // ==================== Aggregated equity ====================

  app.get('/equity', async (c) => {
    const equity = await ctx.accountManager.getAggregatedEquity()
    return c.json(equity)
  })

  // ==================== FX rates ====================

  app.get('/fx-rates', async (c) => {
    // Collect all unique currencies from positions across all accounts
    const currencies = new Set<string>()
    for (const uta of ctx.accountManager.resolve()) {
      if (uta.health === 'offline') continue
      try {
        const positions = await uta.getPositions()
        for (const p of positions) {
          if (p.currency && p.currency !== 'USD') currencies.add(p.currency)
        }
        const account = await uta.getAccount()
        if (account.baseCurrency && account.baseCurrency !== 'USD') currencies.add(account.baseCurrency)
      } catch { /* skip unhealthy */ }
    }

    const rates: Array<{ currency: string; rate: number; source: string; updatedAt: string }> = []
    for (const cur of currencies) {
      const fx = await ctx.fxService.getRate(cur)
      rates.push({ currency: cur, rate: fx.rate, source: fx.source, updatedAt: fx.updatedAt })
    }
    return c.json({ rates })
  })

  // ==================== Per-account routes ====================

  // Reconnect
  app.post('/accounts/:id/reconnect', async (c) => {
    const id = c.req.param('id')
    const result = await ctx.accountManager.reconnectAccount(id)
    return c.json(result, result.success ? 200 : 500)
  })

  // Account info
  app.get('/accounts/:id/account', async (c) => {
    const account = resolveAccount(ctx, c)
    if (!account) return c.json({ error: 'Account not found' }, 404)
    return queryAccount(c, account, () => account.getAccount())
  })

  // Positions
  app.get('/accounts/:id/positions', async (c) => {
    const account = resolveAccount(ctx, c)
    if (!account) return c.json({ error: 'Account not found' }, 404)
    return queryAccount(c, account, async () => ({ positions: await account.getPositions() }))
  })

  // Orders
  app.get('/accounts/:id/orders', async (c) => {
    const account = resolveAccount(ctx, c)
    if (!account) return c.json({ error: 'Account not found' }, 404)
    return queryAccount(c, account, async () => {
      const idsParam = c.req.query('ids')
      const orderIds = idsParam ? idsParam.split(',') : account.getPendingOrderIds().map(p => p.orderId)
      const orders = await account.getOrders(orderIds)
      return { orders }
    })
  })

  // Market clock
  app.get('/accounts/:id/market-clock', async (c) => {
    const account = resolveAccount(ctx, c)
    if (!account) return c.json({ error: 'Account not found' }, 404)
    return queryAccount(c, account, () => account.getMarketClock())
  })

  // Quote
  app.get('/accounts/:id/quote/:symbol', async (c) => {
    const account = resolveAccount(ctx, c)
    if (!account) return c.json({ error: 'Account not found' }, 404)
    return queryAccount(c, account, async () => {
      const { Contract } = await import('@traderalice/ibkr')
      const contract = new Contract()
      contract.symbol = c.req.param('symbol')
      return account.getQuote(contract)
    })
  })

  // ==================== Per-account wallet/git routes ====================

  app.get('/accounts/:id/wallet/log', (c) => {
    const uta = ctx.accountManager.get(c.req.param('id'))
    if (!uta) return c.json({ error: 'Account not found' }, 404)
    const limit = Number(c.req.query('limit')) || 20
    const symbol = c.req.query('symbol') || undefined
    return c.json({ commits: uta.log({ limit, symbol }) })
  })

  app.get('/accounts/:id/wallet/show/:hash', (c) => {
    const uta = ctx.accountManager.get(c.req.param('id'))
    if (!uta) return c.json({ error: 'Account not found' }, 404)
    const commit = uta.show(c.req.param('hash'))
    if (!commit) return c.json({ error: 'Commit not found' }, 404)
    return c.json(commit)
  })

  app.get('/accounts/:id/wallet/status', (c) => {
    const uta = ctx.accountManager.get(c.req.param('id'))
    if (!uta) return c.json({ error: 'Account not found' }, 404)
    return c.json(uta.status())
  })

  // Reject (records a user-rejected commit, clears staging)
  app.post('/accounts/:id/wallet/reject', async (c) => {
    const uta = ctx.accountManager.get(c.req.param('id'))
    if (!uta) return c.json({ error: 'Account not found' }, 404)
    if (!uta.status().pendingMessage) return c.json({ error: 'Nothing to reject' }, 400)
    try {
      const body = await c.req.json().catch(() => ({}))
      const reason = typeof body.reason === 'string' ? body.reason : undefined
      const result = await uta.reject(reason)
      return c.json(result)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // Push (manual approval — the AI tool is hollowed out, only humans can push)
  app.post('/accounts/:id/wallet/push', async (c) => {
    const uta = ctx.accountManager.get(c.req.param('id'))
    if (!uta) return c.json({ error: 'Account not found' }, 404)
    if (!uta.status().pendingMessage) return c.json({ error: 'Nothing to push' }, 400)
    try {
      const result = await uta.push()
      return c.json(result)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ==================== Snapshot routes ====================

  // Per-account snapshots
  app.get('/accounts/:id/snapshots', async (c) => {
    if (!ctx.snapshotService) return c.json({ snapshots: [] })
    const id = c.req.param('id')
    const limit = Number(c.req.query('limit')) || 100
    try {
      const snapshots = await ctx.snapshotService.getRecent(id, limit)
      return c.json({ snapshots })
    } catch {
      return c.json({ snapshots: [] })
    }
  })

  app.delete('/accounts/:id/snapshots/:timestamp', async (c) => {
    if (!ctx.snapshotService) return c.json({ error: 'Snapshot service not available' }, 503)
    const id = c.req.param('id')
    const timestamp = decodeURIComponent(c.req.param('timestamp'))
    const deleted = await ctx.snapshotService.deleteSnapshot(id, timestamp)
    if (!deleted) return c.json({ error: 'Snapshot not found' }, 404)
    return c.json({ success: true })
  })

  // Aggregated equity curve across all accounts
  app.get('/snapshots/equity-curve', async (c) => {
    if (!ctx.snapshotService) return c.json({ points: [] })
    const limit = Number(c.req.query('limit')) || 200

    try {
      const accounts = ctx.accountManager.resolve()
      // Gather snapshots per account
      const perAccount = await Promise.all(
        accounts.map(async (uta) => {
          const snaps = await ctx.snapshotService!.getRecent(uta.id, limit)
          return { id: uta.id, label: uta.label, snaps }
        }),
      )

      // Build time-indexed map: group snapshots by minute-rounded timestamp
      const timeMap = new Map<string, { equity: number; accounts: Record<string, string> }>()

      for (const { id: accId, snaps } of perAccount) {
        for (const snap of snaps) {
          // Round to nearest minute for grouping
          const d = new Date(snap.timestamp)
          d.setSeconds(0, 0)
          const key = d.toISOString()

          let entry = timeMap.get(key)
          if (!entry) {
            entry = { equity: 0, accounts: {} }
            timeMap.set(key, entry)
          }
          entry.accounts[accId] = snap.account.netLiquidation
          // Recalculate total equity from all accounts at this time
          entry.equity = Object.values(entry.accounts).reduce((s, v) => s + (Number(v) || 0), 0)
        }
      }

      // Sort chronologically
      const sorted = Array.from(timeMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))

      // Carry forward: fill missing accounts with their last known value
      const allAccountIds = accounts.map(a => a.id)
      const lastKnown: Record<string, string> = {}

      const points = sorted.map(([timestamp, { accounts: accs }]) => {
        // Fill missing accounts from last known
        for (const id of allAccountIds) {
          if (!(id in accs) && id in lastKnown) {
            accs[id] = lastKnown[id]
          }
        }
        // Update last known
        Object.assign(lastKnown, accs)
        // Recalculate equity with filled values
        const equity = Object.values(accs).reduce((s, v) => s + (Number(v) || 0), 0)
        return { timestamp, equity: String(equity), accounts: accs }
      })

      return c.json({ points })
    } catch {
      return c.json({ points: [] })
    }
  })

  return app
}
