# Contributing to Journeys

Thanks for wanting to help. Bug reports, ideas and code are all welcome.

## Two principles every feature has to fit

1. **Journeys never puts barriers in your way.** It gives you reasons to keep flying, never rules you have to follow. No
   economy, no "you can't fly that yet", no penalties. Anything restrictive, like No teleport, is a setting the player
   chooses, and turning it off is always free.
2. **Journeys plans whole trips, not single flights.** It suggests where to stop, and leaves setting up each flight to the
   pilot and their tools of choice. No routing, charts, or sending flight plans to the sim; SimBrief, Navigraph and the
   aircraft's own avionics already do that well.

If you're unsure whether an idea fits, open an issue to talk it through first.

## Reporting a bug

[Open an issue](https://github.com/codyspate/journeys/issues) and include:

- what you did, what you expected, and what happened instead;
- the aircraft, if it's about saving, restoring or logging;
- a screenshot if it's about something on screen.

## Making a change

1. Fork the repository and create a branch.
2. `npm install`, then `npm run dev` to run the app.
3. Make your change. Logic belongs in `src/core` where it can be tested without the sim; add or update tests there.
4. Check everything passes:
   ```bash
   npm run typecheck
   npm test
   ```
5. Open a pull request describing what changed and why, and how you checked it. Screenshots help for anything visual.

A few habits the codebase follows:

- **Write for players.** On-screen text should be plain and specific: say what happened and what the player can do, with
  no jargon or blame.
- **Never lose a player's data.** Anything that changes stored data should cope with older data, and anything destructive
  asks first.
- **Testing against the live sim:** run a second copy with `JOURNEYS_NO_SIM=1` and its own `--user-data-dir` so it can't
  touch the aircraft or flight you're flying.

## License

By contributing, you agree that your contributions are licensed under the project's
[GNU General Public License v3.0 or later](LICENSE).
