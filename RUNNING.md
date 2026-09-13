# How to Run the Transcription App

Step-by-step guide for starting both servers from VS Code. Follow in order. You need **two terminals** — one for the backend, one for the frontend.

---

## Before You Start (check once)

You should already have:
- The `venv/` folder in the project root (Python environment)
- The `frontend/node_modules/` folder (frontend packages)

If `node_modules` is missing, see [First-Time Setup](#first-time-setup-only-if-something-is-missing) at the bottom.

---

## Step 1 — Open the Project in VS Code

1. Open **VS Code**.
2. **File → Open Folder…**
3. Choose `/Users/nateb/Projects/transcription-app` and click **Open**.

---

## Step 2 — Open the First Terminal (for the Backend)

1. In the top menu, click **Terminal → New Terminal**.
   - (Or press **Ctrl + `** — the backtick key, top-left of the keyboard.)
2. A terminal panel opens at the bottom. It should already be in the project folder:
   ```
   nateb@... transcription-app %
   ```
   If it is NOT in that folder, type this and press **Enter**:
   ```bash
   cd /Users/nateb/Projects/transcription-app
   ```

---

## Step 3 — Start the Backend

1. Click into the terminal you just opened.
2. Type this command exactly, then press **Enter**:
   ```bash
   venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
   ```
3. **Wait.** The first start is slow (10–30 seconds) — it loads the Whisper speech model.
4. You are ready when you see a line like:
   ```
   Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
   ```
5. **Leave this terminal running.** Do not close it and do not type in it again. The backend lives here.

**Test it (optional):** open a browser to **http://localhost:8000** — you should see:
```
{"message":"Transcription API is running!"}
```

---

## Step 4 — Open a SECOND Terminal (for the Frontend)

> Do NOT reuse the backend terminal — it's busy running the backend.

1. In the terminal panel, click the **`+`** (plus) icon on the right side to open a new terminal.
   - (Or menu: **Terminal → New Terminal**.)
2. A fresh terminal opens, again in the project folder.

---

## Step 5 — Start the Frontend

1. Click into the **second** terminal.
2. Go into the `frontend` folder — type this and press **Enter**:
   ```bash
   cd frontend
   ```
3. Start the dev server — type this and press **Enter**:
   ```bash
   npm run dev
   ```
4. You are ready when you see something like:
   ```
   VITE v8.0.0  ready in 825 ms

   ➜  Local:   http://localhost:5173/
   ```
5. **Leave this terminal running too.**

> If it says a different port (e.g. `http://localhost:5174/`), that's fine — port 5173 was busy. Use whatever URL it prints.

---

## Step 6 — Open the App

1. Open a web browser.
2. Go to **http://localhost:5173** (or the URL Vite printed in Step 5).
3. The app loads. It automatically talks to the backend on port 8000.

✅ Both servers are now running.

---

## How to Stop the Servers

1. Click into the backend terminal, press **Ctrl + C**.
2. Click into the frontend terminal, press **Ctrl + C**.

Both stop. You can close the terminals.

**If a port is stuck** (you get "address already in use" next time), type in any terminal:
```bash
lsof -ti:8000 | xargs kill    # frees the backend port
lsof -ti:5173 | xargs kill    # frees the frontend port
```

---

## Quick Reference (once you know the steps)

| Server   | Terminal | Folder      | Type this                                                               | Runs on               |
|----------|----------|-------------|------------------------------------------------------------------------|-----------------------|
| Backend  | 1st      | project root| `venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000` | http://localhost:8000 |
| Frontend | 2nd      | `frontend`  | `cd frontend` then `npm run dev`                                        | http://localhost:5173 |

---

## First-Time Setup (only if something is missing)

Run these **once** if `venv/` or `node_modules/` don't exist yet. From the project root:

**Backend deps:**
```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
```

**Frontend deps:**
```bash
cd frontend
npm install
cd ..
```

After that, follow Steps 1–6 above normally.
