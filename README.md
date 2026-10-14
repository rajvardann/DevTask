# DevTask

A small personal task manager for software developers. It keeps track of your tasks, helps you plan a day, remembers where you stopped on a task, and gives stray ideas somewhere to go so they don't pull you off what you're doing.

Built for the IU course DLBCSPSE01 (Project: Software Engineering), Task 1. It is one Node.js file for the server and a plain HTML/CSS/JS page for the front end. There is nothing to install.

## What it does

- **Projects and tasks.** Every task belongs to a project and has a status (TODO, IN PROGRESS, DONE), a priority, an optional deadline and an estimate in minutes. The board has one column per status and each column scrolls on its own.
- **Overdue.** A task is overdue when its deadline is before today and it isn't DONE. It is shown in red everywhere. A finished task is never overdue.
- **Plan my day.** Tell it how many hours you have. It picks open tasks by priority, then deadline, then the shorter task first, until the time is used up. You can save the result as today's plan, and the dashboard then shows only that plan. Plans are stored per date, so yesterday's plan never shows up as today's.
- **Work context.** On any task you can write down what you were doing, what you found out and what to do next. The dashboard shows the latest one. This is also the place to note why you got stuck, which is why there is no BLOCKED status.
- **Parking lot.** Jot an idea down in a few seconds and turn it into a task later.

## Running it

You need Node.js 18 or newer.

```
node server.js
```

Then open http://localhost:3000 and create an account. There is no seed data, the first account you register is yours.

To use a different port:

```
PORT=3001 node server.js            # macOS / Linux
$env:PORT=3001; node server.js      # Windows PowerShell
```

The server only listens on `127.0.0.1`, so nobody else on your network can reach it. If you really want that (for a hosted demo, say), start it with `HOST=0.0.0.0`.

## Your data

Everything is stored in `data.json` next to `server.js`. It is created on first run and holds your account, a password hash and all your tasks, so it is listed in `.gitignore` and shouldn't be committed. To start over, stop the server and delete the file.

If `data.json` is ever damaged, the server keeps a copy as `data.json.corrupt-<timestamp>` and starts with an empty store instead of overwriting it.

## Project layout

```
devtask/
├── server.js        HTTP server, JSON API and data storage
├── package.json
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js       the whole front end
└── data.json        created on first run (not in git)
```

## API

All routes except the first four need a logged in session (a cookie called `sid`).

| Route | What it does |
|---|---|
| `GET /api/me`, `POST /api/register`, `POST /api/login`, `POST /api/logout` | account and session |
| `GET/POST /api/projects`, `DELETE /api/projects/:id` | projects (deleting one removes its tasks) |
| `GET/POST /api/tasks`, `PATCH/DELETE /api/tasks/:id` | tasks |
| `GET/POST /api/tasks/:id/context` | work context for a task |
| `GET/POST/DELETE /api/plan` | today's saved plan (optional `?date=YYYY-MM-DD`) |
| `GET/POST /api/parking`, `DELETE /api/parking/:id`, `POST /api/parking/:id/convert` | parking lot |
| `GET /api/dashboard` | counts and the latest work context |

## Known limitations

- Converting a parked idea always puts the task in your first project. There is no project picker yet.
- It is meant for one person on one machine. Data lives in a single JSON file that is rewritten on every change, so it isn't safe for several people or several server processes at once.
- "Today" comes from the clock and timezone of the machine running the server. That is fine when it runs on your own computer.
- There are no automated tests. It was checked by hand and with scripted requests against the API.

## Notes on how it is built

- Passwords are hashed with scrypt and a random salt. Sessions are random tokens in an HttpOnly cookie.
- Every query checks that the project, task or idea belongs to the logged in user, and answers 404 otherwise.
- Overdue is calculated every time a task is read. It is never stored.
- The front end keeps everything in one `state` object and redraws the page from it after every action.
