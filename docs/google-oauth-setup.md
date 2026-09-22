# Connect this fork to Google Drive

Do this once as the fork maintainer. End users will only click **Connect Google Drive** in the launcher.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select or create a project for your fork.
2. Enable the **Google Drive API** in that project. [Google's Drive setup guide](https://developers.google.com/workspace/drive/api/quickstart/js) explains API enablement.
3. Open **Google Auth Platform** and configure the app's branding and support contact. For accounts outside your Workspace organization, choose an external audience. During development, keep the project in testing and add the Google accounts you will use as test users. [Consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent).
4. Declare `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/drive.file`. The launcher uses app-created files; it does not need full-Drive access.
5. Under **Clients**, create an OAuth client with application type **Desktop app**. Download its client configuration JSON. The launcher uses the desktop loopback flow; do not create a web application client or configure a hosted callback server. [Desktop OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app).
6. In a local `.env` file, set `MAIN_VITE_GOOGLE_CLIENT_ID` to `installed.client_id` and `MAIN_VITE_GOOGLE_CLIENT_SECRET` to `installed.client_secret` from that JSON. Keep the file out of Git. Never place your Google password, authorization code, access token, or refresh token in these fields.
7. Install the project dependencies and native prerequisites, then build the launcher using the instructions in `google-drive-saves.md`. These settings are compiled into the main process; changing `.env` requires rebuilding.
8. Open **Settings → Integrations → Google Drive saves**, connect a test account in the system browser, and make a manual backup of disposable test saves. Verify the **Waypoint Saves** folder, then restore and compare the bytes.
9. Repeat on a second device and test offline conflicts, account switching, reconnect, deletion and retention. Do not use irreplaceable saves for the first qualification run.
10. Before distributing publicly, complete production branding, real privacy/support pages, production audience setup and any required verification. A development client or successful test sign-in is not public-release approval. [Google's production requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance).

Leave `MAIN_VITE_RELEASE_OWNER` and `MAIN_VITE_RELEASE_REPO` blank while testing. Once you have a GitHub fork and release process, set both to your own repository in the build and packaging environment. The launcher deliberately rejects the official Hydra release repository.

No Google project or credentials have been created or configured in this delivery. We can complete these steps together when you are ready to sign into your Google account.
