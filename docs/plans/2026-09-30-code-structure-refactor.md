# Code Structure Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve frontend and backend module boundaries without changing HTTP contracts, persistence behavior, or user-visible behavior.

**Architecture:** Keep `App.tsx` as the composition root and extract only stable, dependency-light concerns: frontend domain types/constants/request helpers/utilities, and backend database/path configuration. Preserve all existing route handlers and service functions, so the refactor is import-level rather than behavioral. Do not touch unrelated user changes.

**Tech Stack:** React 19, TypeScript, Vite, FastAPI, SQLite, Python 3.11.

---

### Task 1: Extract frontend shared domain module

**Files:**
- Create: `src/domain.ts`
- Modify: `src/App.tsx:1-72`

**Steps:**
1. Move the frontend type aliases, categories/status constants, summary defaults, money/date parsing helpers, and request helpers into `src/domain.ts`.
2. Export only symbols used by `App.tsx` or its child components.
3. Replace local declarations with imports; preserve runtime behavior and API paths exactly.
4. Run `npm run test -- --run` and `npm run build`.

### Task 2: Extract backend application configuration and database setup

**Files:**
- Create: `backend/database.py`
- Modify: `backend/main.py:3-145`

**Steps:**
1. Move database/path constants, `connect`, and `initialize` into `backend/database.py`.
2. Keep migration SQL and ordering unchanged; expose `connect`, `initialize`, `UPLOAD_DIR`, `AGENT_UPLOAD_DIR`, and size/page limits needed by routes.
3. Import those symbols from `main.py`; do not alter route paths, schemas, or service calls.
4. Run backend tests and import the FastAPI app.

### Task 3: Document the new module boundaries

**Files:**
- Modify: `README.md`

**Steps:**
1. Add a concise development structure section naming `src/domain.ts`, `src/App.tsx`, `backend/database.py`, `backend/services.py`, and `backend/main.py`.
2. State that the split is structural and does not change API behavior.
3. Run the complete verification commands again.
