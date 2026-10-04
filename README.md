# CrewPane

Desktop workspace for running and coordinating multiple coding agents side by side, with built-in terminals, task tracking and a shared skill library.

## Requirements

- Node.js 20+
- Docker (for the local Supabase database)

## Setup

```bash
npm install
cp .env.example .env.local   # fill in your local values
```

## Run

```bash
npm start
```

On Windows you can also use `start.bat`.

## Development

```bash
npm test        # architecture, unit, smoke and characterization tests
npm run lint
```

## Database

Migrations live in `supabase/migrations`. To apply them to the cloud project:

```bash
npm run db:push:cloud
```

## Project layout

| Path | Contents |
|---|---|
| `main.js`, `preload.js` | Electron entry points |
| `src/` | Main-process modules (agents, terminal, services, config, security) |
| `standalone/` | Compiled frontend |
| `packages/` | Internal packages |
| `builtin-skills/` | Skills shipped with the app |
| `supabase/` | Database config and migrations |
| `tests/` | Test suites |

## License

All rights reserved © Eren Atasoy.
