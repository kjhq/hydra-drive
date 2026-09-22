const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

// Runs against the actual packaged executable, with a fresh disposable profile.
// No credentials, personal library, or existing game saves are used.
(async () => {
  const executablePath = process.argv[2];
  if (!executablePath)
    throw new Error("Usage: node scripts/qualify-packaged-ui.cjs <executable>");
  const reportDir = path.resolve(
    process.env.HYDRA_DRIVE_UI_REPORT || ".cache/ui-qualification"
  );
  await fs.mkdir(reportDir, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-drive-ui-"));
  const errors = [];
  const checks = [];
  let application;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({
      executablePath: path.resolve(executablePath),
      args: [`--user-data-dir=${profile}`, "--no-sandbox"],
      env,
      timeout: 60000,
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => errors.push(error.message));
    const runtime = await application.evaluate(({ app }) => ({
      name: app.getName(),
      packaged: app.isPackaged,
      profile: app.getPath("userData"),
    }));
    assert.equal(runtime.name, "Waypoint");
    assert.equal(runtime.packaged, true);
    assert.equal(path.resolve(runtime.profile), path.resolve(profile));
    checks.push("packaged runtime and isolated fork profile");
    await page.waitForFunction(
      () => !!window.electron?.getGoogleDriveConnection
    );
    const connection = await page.evaluate(() =>
      window.electron.getGoogleDriveConnection()
    );
    assert.equal(connection.connected, false);
    assert.equal(connection.account, null);
    assert.equal(await page.evaluate(() => window.electron.getMe()), null);
    checks.push("typed Drive IPC available without Hydra login");
    await page.evaluate(() => {
      window.location.hash = "/settings";
    });
    await page
      .getByRole("button", { name: "Cloud saves", exact: true })
      .click();
    const panel = page.getByRole("region", {
      name: "Google Drive saves",
      exact: true,
    });
    await panel.waitFor({ state: "visible" });
    await panel.locator("[id=drive-connect]").waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="Google Drive saves"]')
          ?.getAttribute("aria-busy") === "false"
    );
    assert.equal(
      await panel
        .getByRole("button", { name: "Connect Google Drive", exact: true })
        .isEnabled(),
      connection.configured
    );
    await page.screenshot({ path: path.join(reportDir, "desktop-drive.png") });
    checks.push(
      "desktop settings show Drive connection and accurate configuration state"
    );
    const nextWindow = application.waitForEvent("window");
    await page.evaluate(() => window.electron.openBigPictureWindow());
    const bigPicture = await nextWindow;
    bigPicture.setDefaultTimeout(30000);
    bigPicture.on("pageerror", (error) => errors.push(error.message));
    await bigPicture.waitForFunction(
      () => !!window.electron?.getGoogleDriveConnection
    );
    await bigPicture.evaluate(() => {
      window.location.hash = "/big-picture/settings";
    });
    await bigPicture
      .getByRole("tab", { name: "Cloud saves", exact: true })
      .click();
    const bigPanel = bigPicture.getByRole("region", {
      name: "Google Drive saves",
      exact: true,
    });
    await bigPanel.waitFor({ state: "visible" });
    await bigPicture.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="Google Drive saves"]')
          ?.getAttribute("aria-busy") === "false"
    );
    assert.equal(
      await bigPanel
        .getByRole("button", { name: "Connect Google Drive", exact: true })
        .isEnabled(),
      connection.configured
    );
    assert.deepEqual(
      await bigPicture.evaluate(() =>
        window.electron.getGoogleDriveConnection()
      ),
      connection
    );
    const layout = await bigPanel.evaluate((element) => ({
      padding: parseFloat(getComputedStyle(element).paddingLeft),
      fontSize: parseFloat(getComputedStyle(element).fontSize),
    }));
    assert(
      layout.padding >= 20,
      "Big Picture save panel must retain its shared spacing"
    );
    assert(layout.fontSize >= 16, "Big Picture save text must remain readable");
    await bigPicture.screenshot({
      path: path.join(reportDir, "big-picture-drive.png"),
    });
    checks.push(
      "Big Picture settings expose the same Drive state and connection action"
    );
    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.join(reportDir, "result.json"),
      JSON.stringify(
        {
          passed: true,
          platform: process.platform,
          checks,
          limitations: [
            "Does not exercise a physical controller or grant Google access.",
          ],
          time: new Date().toISOString(),
        },
        null,
        2
      )
    );
    console.log(JSON.stringify({ passed: true, checks }));
  } catch (error) {
    if (application)
      for (const [index, window] of application.windows().entries()) {
        await window
          .screenshot({ path: path.join(reportDir, `failure-${index}.png`) })
          .catch(() => {});
        await fs.writeFile(
          path.join(reportDir, `failure-${index}.txt`),
          await window
            .locator("body")
            .innerText()
            .catch(() => "")
        );
      }
    await fs.writeFile(
      path.join(reportDir, "result.json"),
      JSON.stringify(
        { passed: false, checks, errors, error: String(error) },
        null,
        2
      )
    );
    throw error;
  } finally {
    await application?.close();
    await fs.rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 1000,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
