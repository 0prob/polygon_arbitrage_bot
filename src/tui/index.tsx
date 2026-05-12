import { render } from 'ink';
import { App } from './App.tsx';
import type { BotState } from './types.ts';

export function startTui(state: BotState): () => void {
  if (!process.stdout.isTTY) return () => {};

  const instance = render(
    <App
      state={state}
      onExit={() => {
        process.kill(process.pid, 'SIGINT');
      }}
    />,
    {
      stdout: process.stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      alternateScreen: false,
      exitOnCtrlC: true,
      patchConsole: true,
      maxFps: 8,
    },
  );

  return () => {
    instance.unmount();
    instance.cleanup();
  };
}
