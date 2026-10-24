# Games by Levi

The ultimate gaming hub: 33 neon games, player accounts, leaderboards, and a place for people to submit their own games.

It runs on **Cloudflare Workers** (the website and server) with a **Cloudflare D1** database (accounts, scores, submitted games). Both are free for a site this size.

## What's in this folder

| Path | What it is |
|---|---|
| `public/index.html` | The whole website: design, games, leaderboards, accounts |
| `public/404.html` | The neon "Game Over" page shown for links that don't exist |
| `public/icon.svg`, `icon-*.png`, `apple-touch-icon.png` | Site icon, also used when someone adds the site to their phone's home screen |
| `public/og.png` | The preview image that appears when the link is shared in chats and on social media |
| `public/manifest.webmanifest`, `robots.txt` | App settings for phones, and rules for search engines |
| `src/worker.js` | The server: sign up, log in, scores, submissions, admin review |
| `schema.sql` | Creates the database tables |
| `wrangler.toml` | Cloudflare settings (project name, database, admin username) |
| `package.json` | Shortcut commands |

## Put it online (about 10 minutes)

You need a free Cloudflare account and Node.js installed on your computer.

1. **Install Node.js** from <https://nodejs.org> (the LTS version). Then open a terminal in this folder and run:

   ```
   npm install
   ```

2. **Log in to Cloudflare** from the terminal. A browser window opens. Click Allow.

   ```
   npx wrangler login
   ```

3. **Create the database:**

   ```
   npx wrangler d1 create games-by-levi
   ```

   It prints a `database_id` that looks like `a1b2c3d4-...`. Open `wrangler.toml` and paste it where it says `PASTE-YOUR-DATABASE-ID-HERE`.

4. **Tables set themselves up.** The first time the site runs, it creates everything it needs in the database. (If you ever want to do it by hand, run `npm run db:remote`.)

5. **Choose the admin name.** In `wrangler.toml`, `ADMIN_USERNAME = "Levi"` decides who can approve and reject submitted games. Change it if you want a different name.

6. **Publish the site:**

   ```
   npm run deploy
   ```

   It prints your site address, like `https://games-by-levi.<your-name>.workers.dev`.

7. **Sign up right away** on your new site with the admin username from step 5 (for example `Levi`). Do this before you share the link, so nobody else can take that name. Your profile will say "Admin", and Approve / Reject buttons appear in the submission queue.

That's it. To publish changes later, edit the files and run `npm run deploy` again.

## Use your own domain (optional)

In the Cloudflare dashboard, go to **Workers & Pages → games-by-levi → Settings → Domains & Routes → Add → Custom domain** and enter a domain you own (for example `gamesbylevi.com`). The domain has to be on your Cloudflare account.

## Try it on your computer first (optional)

```
npm run db:local
npm run dev
```

Then open <http://localhost:8787>. This uses a separate test database, so nothing you do here shows up on the live site.

## How accounts work

- People sign up with a username, password and neon avatar, then log in and out.
- Passwords are never stored as plain text. They're scrambled with PBKDF2 (100,000 rounds plus a random salt) before saving.
- Logins last 30 days, using a secure cookie that the page's JavaScript can't read.
- Repeated wrong passwords are blocked for 15 minutes. Sign-ups, scores and submissions are rate-limited too.
- Players can change their name, avatar and password from their profile.

## How submissions work

- Logged-in players paste a single-file HTML game (200 KB max) and submit it. Each player can have up to 5 games waiting at once.
- The admin approves or rejects games in the queue. Approved games take the next open slot on the 1000-slot wall and get their own leaderboard.
- Submitted games run in a sealed sandbox, so they can't read cookies, log anyone in or out, or touch the rest of the site.
- A game posts a score by calling `parent.postMessage({ type: "gbl:score", score: 123 }, "*")` when a run ends.

## Good to know

- **Scores can be faked** by someone who knows how to send web requests, because the games run in the player's browser. The server rejects impossible values, but a determined cheater could still post a high score. Delete a fake score in the Cloudflare dashboard under **D1 → games-by-levi → Console**, for example: `DELETE FROM scores WHERE user_id = 5 AND game = 'snake';`
- **Back up the database** now and then: `npx wrangler d1 export games-by-levi --remote --output=backup.sql`
- **Free plan limits:** 100,000 requests a day and 5 GB of database storage, plenty for a hobby site.
