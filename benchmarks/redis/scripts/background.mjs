import { compose } from "./lib.mjs";

const STOP_FILE = "/tmp/bg-stop";

export function backgroundScript(background) {
  const common = `redis-cli -h redis`;
  let call;
  let pause = "";
  if (background.command === "HGETALL") {
    call = `${common} HGETALL ${background.target} >/dev/null`;
  } else if (background.command === "KEYS") {
    call = `${common} KEYS '${background.pattern}' >/dev/null`;
  } else if (background.command === "SCAN") {
    call = `${common} --scan --pattern '${background.pattern}' --count ${background.count} >/dev/null`;
  } else {
    throw new Error(`Unsupported background command ${background.command}`);
  }
  if (background.intervalSeconds > 0) pause = `; sleep ${background.intervalSeconds}`;
  return `n=0; while [ ! -f ${STOP_FILE} ]; do ${call} && n=$((n+1))${pause}; done; echo count=$n`;
}

export function parseBackgroundCount(stdout) {
  const match = /count=(\d+)/.exec(stdout);
  if (!match) throw new Error("Background client did not report an execution count");
  return Number(match[1]);
}

export async function startBackground(env, background) {
  if (!background) return { async stop() { return null; } };
  await compose(env, ["exec", "-T", "bgclient", "rm", "-f", STOP_FILE]);
  const running = compose(env, ["exec", "-T", "bgclient", "sh", "-c", backgroundScript(background)]);
  return {
    async stop() {
      await compose(env, ["exec", "-T", "bgclient", "touch", STOP_FILE]);
      const result = await running;
      if (result.code !== 0) throw new Error(`Background client failed: ${result.stderr.trim()}`);
      return { command: background.command, executions: parseBackgroundCount(result.stdout) };
    },
  };
}
