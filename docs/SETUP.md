# Setup and operations

## Local website

Install Node.js 24 or later, clone the repository, and run the quick start in the README. The backend uses Node's SQLite API, so older Node releases are unsupported. The web backend can run on Windows, macOS, or Linux; the packaged startup, tray, and Android signing helpers are PowerShell scripts for Windows.

`npm run setup` creates `data/config.json` without replacing existing settings. It picks the current calendar date and system timezone unless you supply `--start-date` and `--timezone`. Other flags are `--port`, `--public-origin`, and `--allowed-login`. Configuration is validated before startup.

| Setting        | Meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `port`         | Loopback server port, default `4318`                              |
| `startDate`    | Earliest digest body date to import, `YYYY-MM-DD`                 |
| `timezone`     | IANA timezone for pickup cutoffs, such as `America/Chicago`       |
| `publicOrigin` | Your private Tailscale HTTPS origin; empty for local web only     |
| `allowedLogin` | Exact Tailscale login identity allowed to access the app remotely |

Choose the start date and timezone before the first import. Do not change them casually after recording pickups. The application generates a separate random local ingestion key at first startup. Do not paste that key into an AI chat, webpage, Android build, issue, or Git commit; the import helper reads it locally.

Run `npm start` for a foreground server. For web development, run `npm run dev` in a second terminal; its proxy defaults to port 4318. Keep the host awake for remote access and scheduled ingestion.

## Private Tailscale access

1. Install and sign into Tailscale on the server computer and phone.
2. Enable HTTPS/Serve in your own Tailscale account when prompted.
3. Forward your private HTTPS service to the loopback server:

   ```sh
   tailscale serve --bg http://127.0.0.1:4318
   tailscale serve status
   ```

4. Put the exact HTTPS origin shown by Serve in `data/config.json` as `publicOrigin`, and your Tailscale login as `allowedLogin`. Restart the server.
5. Confirm Serve says **tailnet only**. Open the address from an authorized device.

Use your configured port if it differs from 4318. On Windows, the CLI may be at `C:\Program Files\Tailscale\tailscale.exe` if it is not on PATH. **Serve and Funnel are different:** this app expects private Serve, not public Funnel. A shared/tagged node may not have the user identity the app expects and will be denied. See [Tailscale's Serve documentation](https://tailscale.com/docs/features/tailscale-serve).

There is no generic public reverse-proxy deployment recipe here. The identity-header trust model depends on a trusted loopback proxy. See [SECURITY.md](../SECURITY.md).

## Windows tray and desktop shortcut

After configuring and building the web app, run these commands in PowerShell from the repository:

```powershell
.\scripts\build-tray.ps1
.\scripts\install-startup.ps1
.\scripts\start-server.ps1
```

The build uses the Windows .NET Framework compiler and the existing app icon. If your organization's script execution policy blocks a helper, follow your organization's policy rather than disabling it globally. The equivalent Node server can always be started with `npm start` where permitted.

The startup installer registers **Snail Mail local server** for your interactive Windows sign-in and creates a **Snail Mail Server** desktop shortcut. The tray is a GUI executable, and its child Node process is created without a console window. Look under **^** if Windows puts the icon in the overflow area.

- Double-click the tray icon to open the mailbox.
- Right-click to restart the server, read logs, or quit.
- Toggle **Automatically start with Windows** in the tray menu. A checkmark means the tray and server will start when you sign in to your Windows account. This does not run before sign-in or require an administrator account. The option reads the actual Windows scheduled task, including startup enabled by an earlier installation.
- After quitting, double-click the desktop shortcut to start it again. Existing instances are reused.
- Quit the tray before rebuilding its executable.
- Uncheck the startup option to stop future automatic starts; the current server keeps running until you quit it. Quitting does not change the startup setting. Disable your AI schedules separately if you also want ingestion to stop.

The tray manages only the server it starts. If you already started one using `npm start`, stop that process before switching to the tray. The tray exposes `--restart` and `--quit` commands for maintenance. Its private stdin pipe supports graceful server shutdown and prevents an orphaned server when the tray exits.

For manual startup only, run `scripts/install-shortcut.ps1` instead of `scripts/install-startup.ps1`. You can also inspect or change automatic startup from PowerShell with `scripts/set-startup.ps1 -Action status`, `-Action enable`, or `-Action disable`. Both the installer and tray use the same native Windows Task Scheduler integration; it refuses to change a task belonging to another installation or Windows user. The tray option does not launch PowerShell or change script execution policy.

## Android

The repository contains source, not a universal preconfigured APK. Each APK is built for its owner's private Tailscale origin.

Requirements: JDK 21, Android SDK/API 36 and compatible build tools, Node/npm, and the configured Tailscale HTTPS origin. Android Studio can install the SDK. Set `JAVA_HOME` to JDK 21 and `ANDROID_HOME` to the SDK, or set `sdk.dir` in ignored `android/local.properties`. The Windows helper also supports a local JDK in `.tools/jdk21/`.

```powershell
.\scripts\build-android.ps1
```

The helper builds the web app with `VITE_API_ORIGIN` from your private configuration, syncs Capacitor, generates a local release signing key if needed, and writes `releases/snail-mail.apk` and its SHA-256 file. Preserve `data/signing/` securely: future updates need the same signing key. Do not commit or share it.

Install the APK on your own device with Tailscale connected. You can download your personal APK from the website's Settings panel. Android 7/API 24 or newer is required. No Gmail credential or ingestion key is bundled into Android.

On another OS, use the standard Capacitor/Gradle build flow: set `VITE_API_ORIGIN` to exactly the configured `publicOrigin`, build the web app, run `npx cap sync android`, and configure your own release signing in Android Studio. The native build also reads `data/config.json` for its notification endpoint. Both origins must match. The PowerShell release helper is the supported automated signing path.

### Notifications

Open **Settings → Android notifications → Enable notifications** and allow the Android permission prompt. **Send test notification** checks device delivery; **Check now** requests an immediate network check.

WorkManager checks about every 12 hours, subject to Android battery/network delays. The first successful check after enabling establishes a quiet baseline instead of alerting on the entire backlog. Alerts cover newly important/urgent mail, evidenced deadlines within three calendar days, stronger fullness warnings, failed ingestion, and checks more than 30 hours overdue. Persistent connection failures warn after 24 hours of failed checks. Notifications contain generic text rather than sender names or images.

Tailscale must be connected and the server reachable. Pickup removes obsolete notifications at the next successful check. After force-stopping the Android app, open it again. Validate permission, delivery, and notification taps on your own phone; build/test success does not prove device behavior.

Native checks, from `android/` with JDK 21 configured:

```powershell
.\gradlew.bat :app:testReleaseUnitTest :app:lintRelease
```

## Backups and recovery

Stop the server before copying the entire `data/` directory. It contains SQLite, images/thumbnails, original source evidence, configuration, ingestion credentials, and potentially Android signing material. Protect the backup as sensitive data. Restore it only to a trusted device and retain image/source files alongside the database.

Server and tray logs are `data/service.log` and `data/tray.log`. The tray keeps one rotated copy of each and writes its status to `data/tray-status.json`. The website shows the last ingestion check. An empty or stale inbox can mean no mail **or** a broken ingestion workflow: inspect sync status before assuming nothing arrived.

Scheduled ingestion should use the actual checkout/data directory, not a fresh isolated worktree with an empty database. `SNAIL_DATA_DIR` can select a separate data directory for a custom deployment; your server and ingestion helper must agree. Never point a test suite or sample import at your real mailbox.
