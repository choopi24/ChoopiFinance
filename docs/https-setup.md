# HTTPS and installing the app on your phone

## Why this is needed at all

You want the tracker on your home screen behaving like an app — full screen, own
icon, opens instantly. That means a **service worker**, and browsers only run
service workers in a **secure context**: `https://`, or `http://localhost`.

`http://192.168.1.42:3001` is neither. On plain HTTP over a LAN address you can
still "Add to Home Screen", but what you get is a bookmark in a browser chrome,
not an installed app, and nothing works offline.

So: a certificate. Public certificate authorities will not issue one for a
private IP or a `.local` name, so we make our own authority with **mkcert** and
trust it on your own devices. It signs nothing but the certificates you generate
yourself, on your own machine.

**Verified working:** mkcert v1.4.4, certificate issued and served, valid for
~27 months, covering your Mac's Bonjour name, its LAN IP, `localhost`,
`127.0.0.1` and `::1`.

---

## 1. Generate the certificate (on the host machine)

```bash
brew install mkcert nss        # nss makes Firefox trust it too
cd ~/path/to/choopi-finance
npm run setup:https
```

This writes three files into `server/certs/`:

| File | What it is |
|---|---|
| `cert.pem` | the server's certificate |
| `key.pem` | its private key — never leaves this machine, `chmod 600` |
| `rootCA.pem` | your local authority's **public** certificate, to install on devices |

The script prints the names the certificate covers. It automatically includes:

- your Mac's Bonjour name (`something.local`) — resolves from any Apple device
  with zero configuration, and survives a change of IP address
- every private LAN IP the machine currently has
- `localhost`, `127.0.0.1`, `::1`

## 2. Trust the authority on the host machine

This changes a system security setting and needs your password, so run it
yourself:

```bash
mkcert -install
```

Then restart the server. The banner should say `TLS  HTTPS on`.

## 3. Give your LAN IP a permanent home

The certificate is pinned to the IP it saw when you generated it. If your router
hands the Mac a different address next month, the certificate stops matching.

Two options, either is fine:

- **Best:** set a **DHCP reservation** in your router for this machine's MAC
  address, so it always gets the same IP.
- **Or:** just use the `.local` name on your devices, which follows the machine
  wherever it lands. If the IP changes, re-run `npm run setup:https`.

---

## Trusting the CA on each device

The server hands out the CA over plain HTTP on port 3000, precisely because a
device that doesn't trust the certificate yet cannot fetch it over HTTPS:

```
http://<your-lan-ip>:3000/ca
```

### iOS / iPadOS

Two steps, and **the second is the one everybody forgets**.

1. In **Safari** (not Chrome — profile installation needs Safari), open
   `http://<lan-ip>:3000/ca`.
2. iOS says "This website is trying to download a configuration profile". Tap
   **Allow**, then **Close**.
3. **Settings → General → VPN & Device Management → Downloaded Profile** →
   tap the mkcert profile → **Install** (top right) → enter your passcode →
   **Install** again.
4. **Settings → General → About → Certificate Trust Settings** → turn ON the
   switch next to the mkcert certificate. ← *this step*

   Without step 4 the certificate is installed but not trusted for TLS, and
   Safari will still refuse the site with a generic error.

Now open `https://<your-mac>.local:3001` in Safari. No warning. Then
**Share → Add to Home Screen**.

### Android

1. In Chrome, open `http://<lan-ip>:3000/ca` and let it download.
2. **Settings → Security & privacy → More security settings → Encryption &
   credentials → Install a certificate → CA certificate** → **Install anyway**
   → pick the downloaded `choopi-local-ca.crt`.
3. Android warns that a third party may monitor traffic. That third party is
   you; the CA's private key is on your Mac and nowhere else.

Then open `https://<lan-ip>:3001` in Chrome → **⋮ → Add to Home screen** →
it should say **Install**, not "Add shortcut". "Install" means the service
worker registered and you have a real PWA.

> Android's `.local` (mDNS) resolution is unreliable in Chrome. **Use the IP
> address on Android**, which is why the certificate covers it.

### macOS (a second Mac)

```bash
scp your-mac.local:~/path/to/choopi-finance/server/certs/rootCA.pem .
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain rootCA.pem
```

Or double-click `rootCA.pem`, find it in Keychain Access under **System**, open
it, expand **Trust**, and set *When using this certificate* to **Always Trust**.

### Windows

1. Download `http://<lan-ip>:3000/ca` in any browser.
2. Rename it to `choopi-local-ca.crt` if the browser saved it otherwise.
3. Double-click → **Install Certificate** → **Local Machine** → **Place all
   certificates in the following store** → **Browse** → **Trusted Root
   Certification Authorities** → Finish.

Chrome and Edge use the Windows store. Firefox has its own — install `nss` on
the host and re-run `mkcert -install`, or import the CA in Firefox's own
settings.

Windows resolves `.local` names over mDNS in Windows 10+ but not always
reliably; the IP is the safe bet.

---

## Checking it actually worked

Open the app and go to **Settings → Security & install**. It tells you the
truth about the current page:

- **"Secure connection"** (green) — HTTPS is working, the service worker can
  register, Add to Home Screen gives you a real app.
- **"Not a secure context"** (amber) — you are on plain HTTP. Add to Home Screen
  will produce a bookmark. It names the protocol and host so you can see why.
- **"Installed"** — you are running the installed app right now.

In Chrome you can also check DevTools → Application → Service Workers.

---

## If mkcert is not viable for you

It is a real option to skip all of this, and the app is built to work without
it. Be clear about what you give up:

|  | Plain HTTP | HTTPS with mkcert |
|---|---|---|
| Works on the phone | yes | yes |
| Add to Home Screen | yes — but a **bookmark** with browser chrome | yes — a real installed app |
| Own icon and splash | partial (iOS honours the apple-touch-icon) | yes |
| Runs standalone, no URL bar | iOS yes, Android no | yes |
| Service worker / offline shell | **no** | yes |
| Setup cost | none | one command + trusting a CA on each device |

To deliberately run without HTTPS, delete or move `server/certs/` and restart.
The banner will say `TLS OFF` and tell you what that costs. Nothing else in the
app changes — the LAN guard, the passcode, and the backups all work identically.

**What we will not do** is pretend. If the app is on plain HTTP, the Settings
screen says so in as many words rather than showing an "Install" button that
produces a bookmark.

---

## Renewing

mkcert certificates are valid for about 27 months. The startup banner counts
down and warns under 30 days. To renew:

```bash
npm run setup:https      # re-issues from the same CA
```

Restart the server. **Devices do not need to re-trust anything** — the CA is
unchanged, only the leaf certificate is new.

Re-run this too whenever the machine's LAN IP changes.
