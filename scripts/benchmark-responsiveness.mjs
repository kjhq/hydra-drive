import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import ts from "typescript";
import { chromium } from "playwright";

// Isolated production-code workloads. No Electron profile, credentials, network,
// or personal saves are used. --ref measures the same workload against a commit.
const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const ref = option("--ref", null);
const count = Number(option("--count", "3000"));
const output = option("--output", ".cache/performance/responsiveness.json");
const readSource = async (file) => {
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  return ref
    ? execFileSync("git", ["show", `${ref}:${relative}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      })
    : fs.readFile(file, "utf8");
};

const source = await readSource(
  path.join(root, "src/big-picture/src/services/navigation.service.ts")
);
const compiled = ts.transpileModule(
  source.replaceAll("import.meta.env", "({})"),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }
).outputText;
const { NavigationService } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const navigationTrials = [];
for (let trial = 0; trial < 3; trial++) {
  const service = new NavigationService();
  service.registerRegion({
    id: "grid",
    orientation: "horizontal",
    getElement: () => null,
  });
  let snapshots = 0;
  let copiedNodeEntries = 0;
  const unsubscribe = service.subscribe(() => {
    snapshots++;
    copiedNodeEntries += service.getNodes().length;
    service.getRegions();
    service.getLayers();
    copiedNodeEntries += service.getDebugSnapshot().nodeIds.length;
  });
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    service.registerNavigationNode({
      id: `game-${i}`,
      regionId: "grid",
      getElement: () => null,
    });
  }
  await Promise.resolve();
  const elapsedMs = performance.now() - started;
  assert.equal(service.getNodes().length, count);
  assert.equal(service.getCurrentFocusId(), "game-0");
  assert.equal(service.moveFocus("right"), "game-1");
  unsubscribe();
  navigationTrials.push({ elapsedMs, snapshots, copiedNodeEntries });
}

const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { useUserPreferences } from './src/big-picture/src/hooks/use-user-preferences.hook';
      import { useLibrary } from './src/big-picture/src/hooks/use-library.hook';
      function Card() {
        const a = useUserPreferences();
        const b = useUserPreferences();
        return React.createElement('span', { 'data-language': a?.language }, b?.language ?? 'loading');
      }
      function LibraryConsumer() {
        const { library } = useLibrary();
        return React.createElement('output', null, library.length);
      }
      const root = createRoot(document.getElementById('root'));
      window.mountWorkload = count => root.render(React.createElement(React.Fragment, null,
        Array.from({length: count}, (_,i) => React.createElement(Card, {key:'c'+i})),
        Array.from({length: 8}, (_,i) => React.createElement(LibraryConsumer, {key:'l'+i}))
      ));
      window.unmountWorkload = () => root.unmount();
    `,
    resolveDir: root,
    loader: "jsx",
  },
  bundle: true,
  write: false,
  minify: true,
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
  alias: { "@shared": path.join(root, "src/shared/index.ts") },
  plugins: ref
    ? [
        {
          name: "baseline-source",
          setup(plugin) {
            plugin.onLoad(
              { filter: /\.[cm]?[jt]sx?$/ },
              async ({ path: file }) => {
                if (!file.startsWith(path.join(root, "src") + path.sep)) return;
                return {
                  contents: await readSource(file),
                  loader: file.endsWith("tsx") ? "tsx" : "ts",
                };
              }
            );
          },
        },
      ]
    : [],
});

const browser = await chromium.launch({ headless: true });
let renderer;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.evaluate((count) => {
    const callbacks = {
      preferences: new Set(),
      library: new Set(),
      downloads: new Set(),
    };
    const stats = { preferencesReads: 0, libraryReads: 0 };
    const games = Array.from({ length: count }, (_, i) => ({
      id: `steam:${i}`,
      objectId: String(i),
      shop: "steam",
      title: `Game ${i}`,
    }));
    const listen = (type, callback) => {
      callbacks[type].add(callback);
      return () => callbacks[type].delete(callback);
    };
    window.electron = {
      getUserPreferences: async () => {
        stats.preferencesReads++;
        return structuredClone({
          language: "en",
          autoplayAnimatedArtwork: false,
        });
      },
      onUserPreferencesUpdated: (callback) => listen("preferences", callback),
      getLibrary: async () => {
        stats.libraryReads++;
        return structuredClone(games);
      },
      onLibraryBatchComplete: (callback) => listen("library", callback),
      onDownloadsUpdated: (callback) => listen("downloads", callback),
    };
    window.workloadStats = () => ({
      ...stats,
      listeners: Object.fromEntries(
        Object.entries(callbacks).map(([key, value]) => [key, value.size])
      ),
    });
    window.updatePreferences = () =>
      callbacks.preferences.forEach((callback) => callback({ language: "fr" }));
    window.updateLibrary = () =>
      callbacks.library.forEach((callback) => callback());
  }, count);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const heapBytes = async () =>
    (await cdp.send("Performance.getMetrics")).metrics.find(
      (m) => m.name === "JSHeapUsedSize"
    ).value;
  const initialHeap = await heapBytes();
  const started = performance.now();
  await page.evaluate((count) => window.mountWorkload(count), count);
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-language="en"]').length === count &&
      [...document.querySelectorAll("output")].every(
        (el) => el.textContent === String(count)
      ),
    count
  );
  const mountMs = performance.now() - started;
  await cdp.send("HeapProfiler.collectGarbage");
  const mountedHeapDeltaBytes = (await heapBytes()) - initialHeap;
  renderer = {
    mountMs,
    mountedHeapDeltaBytes,
    mount: await page.evaluate(() => window.workloadStats()),
  };
  await page.evaluate(() => {
    window.updatePreferences();
    window.updateLibrary();
  });
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-language="fr"]').length === count,
    count
  );
  renderer.afterUpdate = await page.evaluate(() => window.workloadStats());
  await page.evaluate(() => window.unmountWorkload());
  renderer.afterUnmount = await page.evaluate(() => window.workloadStats());
  assert.deepEqual(renderer.afterUnmount.listeners, {
    preferences: 0,
    library: 0,
    downloads: 0,
  });
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
const report = {
  measuredAt: new Date().toISOString(),
  source: ref ?? "working-tree",
  head: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  count,
  navigation: {
    medianMs: navigationTrials.map((x) => x.elapsedMs).sort((a, b) => a - b)[1],
    trials: navigationTrials,
  },
  renderer,
};
await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (args.includes("--check")) {
  assert.equal(
    renderer.mount.preferencesReads,
    1,
    "Preferences should be loaded once per renderer, not once per hook"
  );
  assert.equal(
    renderer.mount.libraryReads,
    1,
    "Library consumers should share one initial request"
  );
  assert.equal(
    renderer.afterUpdate.libraryReads,
    2,
    "One library event should cause one refresh"
  );
  assert.equal(renderer.mount.listeners.preferences, 1);
  assert.equal(renderer.mount.listeners.library, 1);
  assert.ok(
    navigationTrials.every((x) => x.copiedNodeEntries <= count * 4),
    "Navigation registration must not copy a quadratic number of nodes"
  );
}
