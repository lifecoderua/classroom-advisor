// Review agent health (#84): when the LLM agent itself can't work (its login expired, the CLI
// won't start, the key or quota is gone), one `llm.agent` alert says so instead of a "not
// checked" per item; the next successful call closes it.

import { isAgentError, type LlmProvider } from "../llm/types.ts";
import { type Db, raiseAlert } from "../store/index.ts";
import { MUTE_AUTO, muteAlerts } from "./auto-ack.ts";

export const AGENT_ALERT_CODE = "llm.agent";

/** What the calls through a `trackAgent` provider showed about the agent. */
export interface AgentHealth {
  /** The first agent-side error (`LlmAgentError`), if any. */
  error?: string;
  /** At least one call succeeded. */
  ok: boolean;
}

/** Wraps `provider` so every call records agent health in `health`. */
export function trackAgent(provider: LlmProvider): { provider: LlmProvider; health: AgentHealth } {
  const health: AgentHealth = { ok: false };
  const track = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      const out = await call();
      health.ok = true;
      return out;
    } catch (err) {
      if (isAgentError(err)) health.error ??= err.message;
      throw err;
    }
  };
  return {
    health,
    provider: {
      name: provider.name,
      review: (input, opts) => track(() => provider.review(input, opts)),
      generate: (task, opts) => track(() => provider.generate(task, opts)),
    },
  };
}

export interface AgentAlertResult {
  /** The `llm.agent` alert raised now (the agent just went down). */
  raised?: number;
  /** Open `llm.agent` alerts closed now (the agent works again). */
  recovered: number;
}

/**
 * Raises one `llm.agent` alert when the agent failed and nothing succeeded (unless one is open
 * already), and closes the open ones (reason `auto`) once a call succeeded.
 */
export async function updateAgentAlert(
  db: Db,
  provider: string,
  health: AgentHealth,
  now: Date,
): Promise<AgentAlertResult> {
  const open = await db.alert.findMany({
    where: { code: AGENT_ALERT_CODE, mutedAt: null },
    select: { id: true },
  });
  if (health.ok) {
    if (open.length) {
      await muteAlerts(
        db,
        open.map((a) => a.id),
        MUTE_AUTO,
        now,
      );
    }
    return { recovered: open.length };
  }
  if (!health.error || open.length) return { recovered: 0 };
  const { alert } = await raiseAlert(
    db,
    {
      key: `llm:agent:${now.getTime()}`,
      level: "alert",
      code: AGENT_ALERT_CODE,
      params: { provider, error: health.error },
    },
    now,
  );
  return { raised: alert.id, recovered: 0 };
}
