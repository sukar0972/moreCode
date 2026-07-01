import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

const encoder = new TextEncoder();

export function mockChildProcessHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

export function mockChildProcessSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number },
  options?: {
    readonly commands?: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      options?.commands?.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(mockChildProcessHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}