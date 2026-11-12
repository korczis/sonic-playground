# Changing the user interface

The UI is the owner's Flowbite Pro admin shell (rule `fleet.ui-uses-flowbite-pro`, skill
`majordomus://skill/fleet-flowbite-pro`) built from Tera 2 components (rule
`project.ui-components`), static and progressive (rule `project.site-static-serverless`).
Read `.ai/repo/knowledge/curated/zola-023-tera2-idioms.md` before touching `templates/`.

| Step | Run |
|---|---|
| pick the Pro block the change starts from | follow `majordomus://skill/fleet-flowbite-pro` |
| a repeated unit | a component in `templates/components.html`, called `{{ <name prop={expr} /> }}` |
| shell parts (navbar, sidebar, footer) | `templates/partials/` |
| browser behaviour | `static/js/site.js` (shell) or `static/js/explorer.js` (home); progressive only |
| new utility classes | `npm run css` — `static/css/app.css` is committed and checked |
| a library bump | exact pin in `package.json`, `npm install`, `npm run vendor`, `npm run css` |
| see it | `npm run dev` (zola serve) |
| prove it | `CHROME_PATH=<chrome> SCREENSHOT_DIR=/tmp/shots bash scripts/verify.sh`, then look at the screenshots: desktop and 390 px, light and dark |
| Pro fidelity | `node ~/.claude/skills/flowbite-pro/verify.mjs .` (owner's machine) |
