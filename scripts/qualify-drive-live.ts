/** Opt-in integration qualification. Uses only a fresh synthetic save identity. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { GoogleDriveAuth } from "../src/main/services/google-drive/auth";
import { DriveHttpClient } from "../src/main/services/google-drive/http-client";
import { DriveSaveStoreCore } from "../src/main/services/google-drive/save-store";
import {
  pack,
  hashFile,
  extractVerified,
} from "../src/main/services/google-drive/archive";
import { heads, identityKey } from "../src/main/services/google-drive/model";

app.setName("Waypoint");
app.setPath("userData", path.join(app.getPath("appData"), "Waypoint"));
const reportPath = process.env.HYDRA_DRIVE_QUALIFICATION_REPORT;
if (!reportPath)
  throw new Error(
    "Set HYDRA_DRIVE_QUALIFICATION_REPORT to opt into live test data creation."
  );
const root = path.resolve(
  process.env.HYDRA_DRIVE_QUALIFICATION_WORK || path.resolve(".cache"),
  `drive-live-${randomUUID()}`
);
const identity = {
  kind: "legacy" as const,
  shop: "custom",
  objectId: `qualification-${randomUUID()}`,
};
const results: { name: string; passed: boolean; time: string }[] = [];
const check = async (name: string, run: () => Promise<void>) => {
  await run();
  results.push({ name, passed: true, time: new Date().toISOString() });
  console.log(`PASS ${name}`);
};
let client: DriveHttpClient;
let totalRequests = 0;
let dropNextChunkResponse = false;
let injectedFailures = 0;
const run = async () => {
  await app.whenReady();
  assert(
    GoogleDriveAuth.status().connected,
    "Connect the launcher to Google Drive before running live qualification."
  );
  await fs.mkdir(root, { recursive: true });
  const session = GoogleDriveAuth.session();
  const fetcher: typeof fetch = async (input, init) => {
    totalRequests++;
    let response: Response;
    try {
      response = await fetch(input, init);
      console.log(
        "HTTP",
        init?.method ?? "GET",
        new URL(String(input)).pathname,
        response.status
      );
    } catch (error) {
      console.log(
        "NETWORK",
        init?.method ?? "GET",
        new URL(String(input)).pathname,
        (error as { cause?: { code?: string } }).cause?.code ?? "unknown"
      );
      throw error;
    }
    const range = new Headers(init?.headers).get("Content-Range");
    if (
      dropNextChunkResponse &&
      init?.method === "PUT" &&
      range?.startsWith("bytes 0-")
    ) {
      dropNextChunkResponse = false;
      injectedFailures++;
      await response.body?.cancel();
      throw new TypeError("Injected lost upload acknowledgment");
    }
    return response;
  };
  client = new DriveHttpClient(
    session,
    {
      assert: (s) => GoogleDriveAuth.assert(s),
      accessToken: (s, force) => GoogleDriveAuth.accessToken(s, force),
    },
    fetcher
  );
  const store = async (device: string) => {
    const deviceRoot = path.join(root, device);
    await fs.mkdir(deviceRoot, { recursive: true });
    return new DriveSaveStoreCore(
      client,
      path.join(deviceRoot, "account"),
      deviceRoot,
      root,
      () => GoogleDriveAuth.assert(session)
    );
  };
  let a = await store("device-a"),
    b = await store("device-b");
  const data = path.join(root, "source");
  await fs.mkdir(path.join(data, "files"), { recursive: true });
  const source = path.join(data, "files", "save.bin");
  await fs.writeFile(source, randomBytes(9 * 1024 * 1024));
  const large = path.join(root, "large.tar.gz");
  await pack(data, large);
  const expected = new Map([
    [
      "files/save.bin",
      { hash: await hashFile(source), size: (await fs.stat(source)).size },
    ],
  ]);
  let base: Awaited<ReturnType<typeof a.publish>>;
  await check(
    "live resumable upload survives lost chunk acknowledgment",
    async () => {
      dropNextChunkResponse = true;
      base = await a.publish({
        identity,
        parentIds: [],
        label: "Qualification base",
        archive: large,
      });
      assert.equal(injectedFailures, 1);
      assert.equal((await a.queue()).length, 0);
    }
  );
  await check(
    "second device downloads and validates original save bytes",
    async () => {
      const download = path.join(root, "download.tar.gz");
      await b.download(base!, download);
      assert.equal(await hashFile(download), await hashFile(large));
      const restored = path.join(root, "verified");
      await fs.mkdir(restored);
      await extractVerified(download, restored, expected);
      assert.equal(
        await hashFile(path.join(restored, "files", "save.bin")),
        await hashFile(source)
      );
      await b.acceptBase(identity, base!.id);
    }
  );
  const small = path.join(root, "small.tar.gz");
  await fs.writeFile(source, "device-a progress");
  await pack(data, small);
  const smallHash = await hashFile(small);
  let branchA: typeof base, branchB: typeof base;
  await check(
    "durable queue survives reinitialization and freezes source bytes",
    async () => {
      const op = await a.enqueue({
        identity,
        parentIds: [base!.id],
        label: "Device A offline",
        archive: small,
      });
      await fs.writeFile(small, "source was changed after capture");
      a = await store("device-a");
      assert.equal((await a.queue()).length, 1);
      branchA = await a.publishQueued(op);
      assert.equal(branchA.archiveHash, smallHash);
    }
  );
  await fs.writeFile(source, "device-b progress");
  await pack(data, small);
  await check(
    "independent device publishes a preserved conflict branch",
    async () => {
      branchB = await b.publish({
        identity,
        parentIds: [base!.id],
        label: "Device B offline",
        archive: small,
      });
      assert.notEqual(branchA!.deviceId, branchB.deviceId);
      assert.deepEqual(
        new Set(heads(await a.records(identity)).map((c) => c.id)),
        new Set([branchA!.id, branchB.id])
      );
      assert.equal(
        (await a.history(identity)).filter((c) => c.conflict).length,
        2
      );
    }
  );
  let resolved: typeof base;
  await check("explicit resolution joins both competing heads", async () => {
    resolved = await a.publish({
      identity,
      parentIds: [branchA!.id, branchB!.id],
      label: "Resolved qualification",
      archive: small,
    });
    assert.deepEqual(
      heads(await b.records(identity)).map((c) => c.id),
      [resolved.id]
    );
  });
  await check("labels and pins persist across clients", async () => {
    await a.annotate(resolved!.id, {
      label: "Renamed qualification",
      pinned: true,
    });
    const item = (await b.history(identity)).find((c) => c.id === resolved!.id);
    assert.equal(item?.label, "Renamed qualification");
    assert.equal(item?.pinned, true);
    await a.annotate(resolved!.id, { pinned: false });
  });
  await check(
    "retention keeps ten independent payloads and all ancestry",
    async () => {
      let current = resolved!;
      for (let i = 0; i < 9; i++)
        current = await a.publish({
          identity,
          parentIds: [current.id],
          label: `Retention ${i}`,
          archive: small,
        });
      const history = await b.history(identity);
      assert.equal(history.filter((c) => c.available).length, 10);
      assert.equal(history.length, 13);
      assert.deepEqual(
        heads(await b.records(identity)).map((c) => c.id),
        [current.id]
      );
      resolved = current;
    }
  );
  await check(
    "remote deletion publishes tombstone without changing local source",
    async () => {
      const before = await hashFile(source);
      await b.deleteAll(identity);
      const records = await a.records(identity);
      assert.equal(heads(records).length, 1);
      assert(heads(records)[0].deleted);
      assert.equal(
        (await a.history(identity)).filter((c) => c.available).length,
        0
      );
      assert.equal(await hashFile(source), before);
    }
  );
  await check(
    "stale offline publication remains a conflict with deletion",
    async () => {
      await a.publish({
        identity,
        parentIds: [resolved!.id],
        label: "Stale device test",
        archive: small,
      });
      const current = heads(await b.records(identity));
      assert.equal(current.length, 2);
      assert(current.some((c) => c.deleted));
    }
  );
  await check(
    "access-token refresh succeeds without Hydra credentials",
    async () => {
      await GoogleDriveAuth.accessToken(session, true);
      assert((await a.records(identity)).length > 0);
    }
  );
};
run()
  .then(async () => {
    // Only reversible trash operations on this run's synthetic identity; never touch real backups.
    const files = await client.list(
      `appProperties has { key='application' and value='hydra-drive-v1' } and appProperties has { key='identity' and value='${identityKey(identity)}' }`
    );
    for (const file of files) await client.update(file.id, { trashed: true });
    await fs.writeFile(
      reportPath!,
      JSON.stringify(
        {
          passed: true,
          identity,
          results,
          totalRequests,
          root,
          limitations: [
            "Two simulated device directories on one host, not two physical devices",
            "One Google account; separate-account and OS-specific qualification remains required",
          ],
        },
        null,
        2
      )
    );
    console.log(`Live report: ${reportPath}`);
    app.exit(0);
  })
  .catch(async (error) => {
    await fs.mkdir(path.dirname(reportPath!), { recursive: true });
    await fs.writeFile(
      reportPath!,
      JSON.stringify(
        {
          passed: false,
          identity,
          results,
          totalRequests,
          root,
          error: error instanceof Error ? error.message : "unknown error",
        },
        null,
        2
      )
    );
    console.error(
      "Live qualification failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    app.exit(1);
  });
