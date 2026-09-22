import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

test("preload subscriptions hide IPC events and clean up independently", () => {
  const ipcRenderer = new EventEmitter();
  const require = createRequire(import.meta.url);
  let api: Record<string, (...args: unknown[]) => () => void>;
  const code = ts.transpileModule(
    readFileSync(new URL("./index.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }
  ).outputText;
  runInNewContext(code, {
    exports: {},
    process,
    require: (name: string) =>
      name === "electron"
        ? {
            ipcRenderer,
            contextBridge: {
              exposeInMainWorld: (_name: string, value: typeof api) => {
                api = value;
              },
            },
          }
        : require(name),
  });

  const cases: [string, string, unknown[], unknown[]][] = [
    ["onLibraryBatchComplete", "on-library-batch-complete", [], []],
    ["onDrivePromptChanged", "drive-prompt-changed", [], [null]],
    [
      "onUserPreferencesUpdated",
      "on-user-preferences-updated",
      [],
      [{ language: "en" }],
    ],
    [
      "onExtractionProgress",
      "on-extraction-progress",
      [],
      ["steam", "42", 0.5],
    ],
    [
      "onUpdateAchievements",
      "on-update-achievements-42-steam",
      ["42", "steam"],
      [[{ name: "first" }]],
    ],
    [
      "onBackupDownloadComplete",
      "on-backup-download-complete-42-steam",
      ["42", "steam"],
      [false],
    ],
  ];
  for (const [method, channel, parameters, payload] of cases) {
    const received: unknown[][] = [];
    const callback = (...args: unknown[]) => received.push(args);
    const unsubscribe = api![method](...parameters, callback);
    const unsubscribeOther = api![method](...parameters, callback);
    assert.equal(ipcRenderer.listenerCount(channel), 2, method);
    const privateEvent = { sender: "must stay in preload" };
    ipcRenderer.emit(`${channel}-other`, privateEvent, ...payload);
    assert.equal(received.length, 0, method);
    ipcRenderer.emit(channel, privateEvent, ...payload);
    assert.deepEqual(received, [payload, payload], method);
    unsubscribe();
    unsubscribe();
    assert.equal(ipcRenderer.listenerCount(channel), 1, method);
    ipcRenderer.emit(channel, privateEvent, ...payload);
    assert.deepEqual(received, [payload, payload, payload], method);
    unsubscribeOther();
    assert.equal(ipcRenderer.listenerCount(channel), 0, method);
  }
});
