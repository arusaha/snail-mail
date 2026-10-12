# Security and privacy

Snail Mail is designed for one person on a trusted computer, with optional remote access through private Tailscale Serve. It is not a multi-tenant hosted service.

## Access boundaries

- The backend listens on `127.0.0.1`, not LAN/public interfaces.
- Remote requests must carry the configured Tailscale login identity supplied by Serve. Wrong or missing identities are rejected before API/image routes run. Serve strips client-supplied identity headers before supplying authenticated identity information.
- Host and Origin allowlists, JSON-only mutations, a restrictive content security policy, no-store responses, and disabled framing reduce browser-based exposure.
- Ingestion needs a separate locally generated bearer credential. Website and Android clients do not receive it.
- Original email HTML is parsed as untrusted input, never rendered or executed. Image URLs and promotional click-throughs are not loaded into the inbox.

Use [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), not Funnel. Do not forward the app's port publicly or put it behind another proxy without redesigning authentication. The app trusts its loopback environment and Serve's identity headers.

## Explicit limits

Localhost access has **no separate application login**. Anyone or any process able to use this computer may access the local API. Someone using an unlocked device authenticated with your Tailscale identity can access the remote app. A compromised host or authenticated device is outside the app's protection boundary.

SQLite, image files, source emails, and credentials are **not encrypted by the app**. The app does not harden Windows ACLs or enable disk encryption. Review inherited folder permissions on your system, especially on shared machines; protect your account, disks, and backups. Git ignore rules prevent accidental tracking, not unauthorized filesystem access.

Email access and inference are supplied by your chosen agent/connector. Mail content may be processed by that provider; local storage does not mean local-only inference. Use a provider and email permissions appropriate for your data. Classification can miss important mail, and digest previews do not establish delivery or exact mailbox occupancy.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting if enabled for this repository. Do not post real mail images, addresses, tracking numbers, tokens, attachment download URLs, or personal tailnet hostnames in public issues. Use synthetic data and describe the affected boundary. If private reporting is unavailable, request a private contact channel without publishing exploitation details or personal data.
