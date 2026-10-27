import type { Server } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

/**
 * Log transport errors and the transport close to stderr, and exit non-zero
 * when the transport closes because of an error.
 *
 * The SDK stdio transport closes itself without a word when one message line
 * exceeds its buffer limit (10 MiB) or stdout fails; the process then ended
 * with exit code 0 and an empty stderr. The SDK reports the error through
 * `onerror` and calls `onclose` synchronously in the same call, so an error
 * seen in the current tick marks the close as fatal. Errors that do not close
 * the transport (a line that is not a JSON-RPC message) are logged only.
 * A normal close (stdin ended) is logged and the process exits on its own
 * once in-flight work is done, as before.
 *
 * Only the error name and a truncated message are logged, never the stack or
 * the full SDK validation message: that message quotes the offending input,
 * so one large invalid line would otherwise be repeated on stderr.
 */
export function watchTransport(
  server: Server,
  logger: Logger,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let fresh: unknown;
  server.onerror = (err) => {
    logger.error({ error: summarize(err) }, "mcp transport error");
    fresh = err;
    queueMicrotask(() => {
      fresh = undefined;
    });
  };
  server.onclose = () => {
    if (fresh !== undefined) {
      logger.error({ error: summarize(fresh) }, "mcp transport closed after an error, exiting");
      exit(1);
      return;
    }
    logger.info("mcp transport closed");
  };
}

const MESSAGE_MAX_CHARS = 300;

function summarize(err: unknown): { name: string; message: string } {
  const name = err instanceof Error ? err.name : typeof err;
  const text = err instanceof Error ? err.message : String(err);
  const message =
    text.length > MESSAGE_MAX_CHARS
      ? `${text.slice(0, MESSAGE_MAX_CHARS)} [truncated, ${text.length - MESSAGE_MAX_CHARS} more characters]`
      : text;
  return { name, message };
}
