/* ═══════════════════════════════════════════════════════════
   Translucent Kanban — board rules

   Which column a task is in, where it goes when it moves, whose it
   is, and what the filters show. Every function here is pure and
   returns a new list rather than changing the one it was given; when
   nothing would change it returns the list it was given, so the
   caller can skip a save by comparing references.

   A task is { id, text, priority, status, assignee, createdAt }.
   priority is "high", "medium", "low" or "". status is one of
   STATUSES. assignee is a free-text name, "" when nobody has it.

   Loads as a plain script in the browser (window.Board) and as a
   CommonJS module under Node, which is how tests/board.test.js
   reaches it.
   ═══════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = api;
  } else {
    root.Board = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /* Left to right on the board, and the order a task moves through. */
  const STATUSES = ["assigned", "completed", "submitted"];

  const LABELS = {
    assigned: "Assigned",
    completed: "Completed",
    submitted: "Submitted",
  };

  /* Person filter values that are not names. A name is never null, and an
     empty name means unassigned, so neither can collide with a real one. */
  const EVERYONE = null;
  const UNASSIGNED = "";

  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

  const same = (a, b) => a.toLowerCase() === b.toLowerCase();

  function next(status) {
    const i = STATUSES.indexOf(status);
    return i >= 0 && i < STATUSES.length - 1 ? STATUSES[i + 1] : null;
  }

  function prev(status) {
    const i = STATUSES.indexOf(status);
    return i > 0 ? STATUSES[i - 1] : null;
  }

  /* Make a stored task safe to draw. A task whose status is missing or
     unknown would be in no column: saved, counted, and never shown. One from
     the list version of this app has `done` instead, which maps to completed
     (done by the person, not yet handed in). */
  function normalize(t) {
    const { done, ...rest } = t;
    const status = STATUSES.includes(t.status)
      ? t.status
      : done
        ? "completed"
        : "assigned";
    return {
      ...rest,
      priority: t.priority || "",
      status,
      assignee: typeof t.assignee === "string" ? t.assignee.trim() : "",
    };
  }

  /* Moved tasks go first, so a card lands at the top of its priority group in
     the new column rather than somewhere in the middle of it. */
  function move(tasks, id, status) {
    if (!STATUSES.includes(status)) return tasks;
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status === status) return tasks;
    return [{ ...t, status }, ...tasks.filter((x) => x.id !== id)];
  }

  function assign(tasks, id, name) {
    const assignee = (name || "").trim();
    const t = tasks.find((x) => x.id === id);
    if (!t || t.assignee === assignee) return tasks;
    return tasks.map((x) => (x.id === id ? { ...x, assignee } : x));
  }

  /* Every assignee once, ignoring case, keeping the first spelling seen. */
  function people(tasks) {
    const seen = [];
    for (const t of tasks) {
      if (t.assignee && !seen.some((p) => same(p, t.assignee))) {
        seen.push(t.assignee);
      }
    }
    return seen.sort((a, b) => a.localeCompare(b));
  }

  /* A person filter for someone with no tasks left would show an empty board
     with no chip to explain why, so it falls back to everyone. */
  function resolvePerson(person, tasks) {
    if (person === EVERYONE || person === UNASSIGNED) return person;
    return tasks.some((t) => t.assignee && same(t.assignee, person))
      ? person
      : EVERYONE;
  }

  function matches(t, search, person) {
    if (person === UNASSIGNED && t.assignee) return false;
    if (person && !(t.assignee && same(t.assignee, person))) return false;
    const q = (search || "").trim().toLowerCase();
    if (!q) return true;
    return (
      t.text.toLowerCase().includes(q) ||
      t.assignee.toLowerCase().includes(q)
    );
  }

  /* { assigned: [...], completed: [...], submitted: [...] }, each sorted by
     priority. Array.prototype.sort is stable, so tasks of equal priority keep
     their list order, which puts the newest and most recently moved first. */
  function columns(tasks, { search = "", person = EVERYONE } = {}) {
    const cols = Object.fromEntries(STATUSES.map((s) => [s, []]));
    for (const t of tasks) {
      if (cols[t.status] && matches(t, search, person)) cols[t.status].push(t);
    }
    const rank = (t) => PRIORITY_RANK[t.priority] ?? 3;
    for (const s of STATUSES) cols[s].sort((a, b) => rank(a) - rank(b));
    return cols;
  }

  function progress(tasks) {
    const total = tasks.length;
    const submitted = tasks.filter((t) => t.status === "submitted").length;
    return {
      submitted,
      total,
      pct: total ? Math.round((submitted / total) * 100) : 0,
    };
  }

  return {
    STATUSES,
    LABELS,
    EVERYONE,
    UNASSIGNED,
    next,
    prev,
    normalize,
    move,
    assign,
    people,
    resolvePerson,
    columns,
    progress,
  };
});
