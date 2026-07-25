# Setting up Car Costs from scratch

The ten-minute version, assuming you've never used Docker. If you already run
containers, the [README's Run section](../README.md#run) is all you need.

Car Costs runs on a computer that stays on at home — an old laptop, a mini PC,
a Raspberry Pi, or a NAS. Your phone then opens it over your home WiFi — and from anywhere, once you add Tailscale in step 4.

## 1. Install Docker

Docker is the runtime the app ships in — installing it means you never worry
about Python versions or dependencies.

- **Windows or Mac:** install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  (free for personal use). Start it once after installing.
- **Linux or Raspberry Pi:** run the official convenience script:

  ```
  curl -fsSL https://get.docker.com | sh
  ```

  Then log out and back in (it adds your user to the `docker` group).

## 2. Start the app

Open a terminal (on Windows: PowerShell) and paste:

```
docker run -d --name carcosts --restart unless-stopped \
  -p 8000:8000 -v carcosts-data:/srv/data \
  ghcr.io/colfin22/car-costs:latest
```

That downloads the app and starts it. It restarts itself after reboots.

Now open **http://localhost:8000** in a browser on the same machine — you
should see the Car Costs home screen. Tap **+ Add car** and you're away.

## 3. Open it on your phone

Your phone needs the *computer's* address, not `localhost`:

1. Find the computer's IP address on your network — on Windows `ipconfig`
   (look for "IPv4 Address"), on Linux/Mac/Pi `hostname -I` or `ifconfig`.
   It'll look like `192.168.1.23`.
2. On your phone (same WiFi), open `http://192.168.1.23:8000`.
3. Add it to your home screen so it behaves like a normal app:
   **Android/Chrome:** menu → *Add to Home Screen*.
   **iPhone/Safari:** share button → *Add to Home Screen*.

Tip: give the computer a fixed IP in your router's settings (often called a
DHCP reservation) so the address never changes.

## 4. Use it at the pump — access away from home

The steps above only work on your home WiFi, but the app is built to be used
at the forecourt. The recommended fix is **[Tailscale](https://tailscale.com/)**
(free for personal use): it puts your phone and the computer on a private
network of their own, so the app works anywhere you have signal — with nothing
exposed to the internet and no router configuration.

1. Create a Tailscale account and install it on the computer running Car
   Costs ([download page](https://tailscale.com/download)) — on Linux/Pi:
   `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`
   and follow the login link.
2. Install the Tailscale app on your phone and sign in to the same account.
3. Run `tailscale ip -4` on the computer (or check the phone app's machine
   list) — you'll get an address like `100.x.y.z`. On your phone, open
   `http://100.x.y.z:8000`.
4. Re-do *Add to Home Screen* with this address — it now works at home **and**
   at the pump. Leave the Tailscale app connected (it's designed to stay on;
   battery cost is negligible).

**Alternatives:** [ZeroTier](https://www.zerotier.com/) works the same way if
you prefer it. **Port forwarding on your router is not recommended** — it
exposes the app to the whole internet; if you go that route anyway, the
password in the next step is mandatory, and read the
[security model](../README.md#security-model-when-exposed-to-the-internet)
in the README first. With Tailscale/ZeroTier nothing is exposed, and the
password stays optional.

## 5. Optional: set a password

On your home network the app runs open by default. To gate it behind a
password (required if you ever expose it to the internet — read the README's
security-model section first):

```
docker rm -f carcosts
docker run -d --name carcosts --restart unless-stopped \
  -p 8000:8000 -v carcosts-data:/srv/data \
  -e CARCOSTS_PASSWORD='pick-something-long' \
  ghcr.io/colfin22/car-costs:latest
```

(Removing and re-running the container never touches your data — it lives in
the `carcosts-data` volume.)

## 6. Backups

Everything — cars, entries, photos, documents — is in one folder. Copy it out
whenever you like:

```
docker run --rm -v carcosts-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/carcosts-backup.tar.gz -C /data .
```

That drops `carcosts-backup.tar.gz` in your current folder. Keep a copy
somewhere off the machine.

## 7. Updating

```
docker pull ghcr.io/colfin22/car-costs:latest
docker rm -f carcosts
```

…then re-run the same `docker run` command from step 2 (or 5). Data survives —
it's in the volume, not the container.

## Troubleshooting

- **`docker: command not found`** — Docker isn't installed or (Windows/Mac)
  Docker Desktop isn't running.
- **The page loads on the computer but not the phone** — you're using
  `localhost` on the phone (use the computer's IP), the phone is on a
  different WiFi band/guest network, or the computer's firewall is blocking
  port 8000 (on Windows, allow it when prompted).
- **`port is already allocated`** — something else is using port 8000. Change
  the first number: `-p 8080:8000`, then browse to `:8080`.
- **Still stuck?** [Open an issue](https://github.com/colfin22/car-costs/issues)
  with what you ran and what it said — setup friction reports are exactly what
  testing is for.
