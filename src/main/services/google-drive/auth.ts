import type { GoogleDriveConnection } from "@types";
import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { DriveError } from "./errors";
import {
  canPersistTokens,
  createOAuthChallenge,
  GOOGLE_SCOPES,
  validOAuthState,
} from "./oauth-policy";

type Account = NonNullable<GoogleDriveConnection["account"]>;
interface Credentials {
  account: Account;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}
export interface DriveSession {
  accountId: string;
  generation: number;
  signal: AbortSignal;
}
const context = new AsyncLocalStorage<DriveSession>();
const clientId = () => import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID?.trim() ?? "";
const clientSecret = () =>
  import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET?.trim() ?? "";

export class GoogleDriveAuth {
  private static credentials: Credentials | null = null;
  private static initialized = false;
  private static controller = new AbortController();
  private static generation = 0;
  private static refresh: Promise<string> | null = null;
  private static loginController: AbortController | null = null;
  private static reconnect = false;

  private static file() {
    return path.join(app.getPath("userData"), "google-drive-credentials.json");
  }
  static persistent() {
    return canPersistTokens(
      process.platform,
      safeStorage.isEncryptionAvailable(),
      process.platform === "linux"
        ? safeStorage.getSelectedStorageBackend()
        : "native"
    );
  }
  private static load() {
    if (this.initialized || !app.isReady()) return;
    this.initialized = true;
    try {
      if (!this.persistent()) return;
      const disk = JSON.parse(fs.readFileSync(this.file(), "utf8"));
      if (disk.clientId !== clientId()) return;
      const value = JSON.parse(
        safeStorage.decryptString(Buffer.from(disk.encrypted, "base64"))
      );
      if (
        typeof value.account?.id === "string" &&
        typeof value.refreshToken === "string"
      )
        this.credentials = value;
    } catch {
      /* A missing/unreadable keyring requires a new connection. */
    }
  }
  private static persist() {
    if (!this.credentials) return;
    if (!this.persistent()) {
      fs.rmSync(this.file(), { force: true });
      return;
    }
    const file = this.file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      `${file}.tmp`,
      JSON.stringify({
        clientId: clientId(),
        encrypted: safeStorage
          .encryptString(JSON.stringify(this.credentials))
          .toString("base64"),
      }),
      { mode: 0o600 }
    );
    fs.renameSync(`${file}.tmp`, file);
  }
  private static notify() {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send(
          "google-drive-connection-changed",
          this.status()
        );
    }
  }
  static status(): GoogleDriveConnection {
    this.load();
    return {
      configured: Boolean(clientId()),
      connected: Boolean(this.credentials),
      account: this.credentials?.account ?? null,
      persistent: app.isReady() && this.persistent(),
      needsReconnect: this.reconnect,
    };
  }
  static isConnected() {
    return this.status().connected;
  }
  static session(): DriveSession {
    this.load();
    const pinned = context.getStore();
    if (pinned) {
      this.assert(pinned);
      return pinned;
    }
    if (!this.credentials) throw new DriveError("drive_not_connected");
    return {
      accountId: this.credentials.account.id,
      generation: this.generation,
      signal: this.controller.signal,
    };
  }
  static accountId() {
    return this.session().accountId;
  }
  static assert(session: DriveSession) {
    if (
      session.signal.aborted ||
      session.generation !== this.generation ||
      session.accountId !== this.credentials?.account.id
    )
      throw new DriveError("drive_account_changed");
  }
  static withSession<T>(operation: () => T): T {
    return context.run(this.session(), operation);
  }
  static withOptionalSession<T>(operation: () => T): T {
    return this.isConnected() ? this.withSession(operation) : operation();
  }
  static disconnect() {
    this.loginController?.abort();
    this.controller.abort();
    this.controller = new AbortController();
    this.generation++;
    this.credentials = null;
    this.refresh = null;
    this.reconnect = false;
    this.initialized = true;
    fs.rmSync(this.file(), { force: true });
    this.notify();
    return this.status();
  }
  private static async tokenRequest(
    body: URLSearchParams,
    signal: AbortSignal
  ) {
    body.set("client_id", clientId());
    if (clientSecret()) body.set("client_secret", clientSecret());
    let response: Response;
    try {
      response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      throw new DriveError(
        signal.aborted ? "drive_cancelled" : "drive_offline"
      );
    }
    if (!response.ok)
      throw new DriveError(
        response.status >= 500 ? "drive_offline" : "drive_reconnect_required"
      );
    const token = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };
    if (!token.access_token || !Number.isFinite(token.expires_in))
      throw new DriveError("drive_reconnect_required");
    return token;
  }
  static async accessToken(
    session: DriveSession,
    force = false
  ): Promise<string> {
    this.assert(session);
    if (this.reconnect) throw new DriveError("drive_reconnect_required");
    if (!force && this.credentials!.expiresAt > Date.now() + 60_000)
      return this.credentials!.accessToken;
    if (this.refresh) return this.refresh;
    const pending = (async () => {
      try {
        const token = await this.tokenRequest(
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: this.credentials!.refreshToken,
          }),
          session.signal
        );
        this.assert(session);
        this.credentials = {
          ...this.credentials!,
          accessToken: token.access_token,
          expiresAt: Date.now() + token.expires_in * 1000,
        };
        this.persist();
        return token.access_token;
      } catch (error) {
        if (
          error instanceof DriveError &&
          error.code === "drive_reconnect_required" &&
          session.generation === this.generation
        ) {
          this.reconnect = true;
          this.notify();
        }
        throw error;
      }
    })();
    this.refresh = pending;
    try {
      return await pending;
    } finally {
      if (this.refresh === pending) this.refresh = null;
    }
  }
  static async connect(): Promise<GoogleDriveConnection> {
    if (!clientId()) throw new DriveError("drive_not_configured");
    if (!this.persistent()) {
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "Session-only Google connection",
        message: "A secure system keyring is unavailable.",
        detail:
          "Connect for this session only? You will need to reconnect after closing Waypoint.",
        buttons: ["Cancel", "Connect for this session"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) throw new DriveError("drive_cancelled");
    }
    this.loginController?.abort();
    const controller = new AbortController();
    this.loginController = controller;
    const { verifier, challenge, state } = createOAuthChallenge();
    let resolveCode!: (code: string) => void;
    let rejectCode!: (reason: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    // Attach immediately so cancellation while opening a browser cannot become unhandled.
    void codePromise.catch(() => undefined);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.method !== "GET" ||
        url.pathname !== "/oauth/callback" ||
        !validOAuthState(state, url.searchParams.get("state"))
      ) {
        response.writeHead(400).end("Invalid authorization response.");
        return;
      }
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.has("error")) {
        response.end("Connection cancelled. Return to the launcher.");
        rejectCode(new DriveError("drive_cancelled"));
      } else {
        response.end("Authorization received. Return to the launcher.");
        resolveCode(code);
      }
    });
    const abort = () => rejectCode(new DriveError("drive_cancelled"));
    controller.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new DriveError("drive_request_failed");
      const redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
      const params = new URLSearchParams({
        client_id: clientId(),
        redirect_uri: redirect,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent select_account",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      await shell.openExternal(
        `https://accounts.google.com/o/oauth2/v2/auth?${params}`
      );
      const code = await codePromise;
      const token = await this.tokenRequest(
        new URLSearchParams({
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          grant_type: "authorization_code",
        }),
        controller.signal
      );
      if (
        !token.refresh_token ||
        !token.scope?.split(" ").includes(GOOGLE_SCOPES[3])
      )
        throw new DriveError("drive_reconnect_required");
      const response = await fetch(
        "https://openidconnect.googleapis.com/v1/userinfo",
        {
          headers: { Authorization: `Bearer ${token.access_token}` },
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30_000),
          ]),
        }
      );
      if (!response.ok) throw new DriveError("drive_reconnect_required");
      const user = (await response.json()) as {
        sub: string;
        email: string;
        name?: string;
      };
      if (!user.sub || !user.email)
        throw new DriveError("drive_reconnect_required");
      if (controller.signal.aborted || this.loginController !== controller)
        throw new DriveError("drive_cancelled");
      this.controller.abort();
      this.controller = new AbortController();
      this.generation++;
      this.credentials = {
        account: {
          id: user.sub,
          email: user.email,
          name: user.name ?? user.email,
        },
        refreshToken: token.refresh_token,
        accessToken: token.access_token,
        expiresAt: Date.now() + token.expires_in * 1000,
      };
      this.initialized = true;
      this.refresh = null;
      this.reconnect = false;
      this.persist();
      this.notify();
      return this.status();
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", abort);
      server.closeAllConnections();
      server.close();
      if (this.loginController === controller) this.loginController = null;
    }
  }
}
