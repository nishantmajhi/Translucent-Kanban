/* Tests for the board rules.
 *
 * node --test tests/
 *
 * src/board.js decides which column a task is in, where it goes when moved,
 * whose it is, and what the filters show. The interface only draws the
 * result, so these are the tests that say whether the board is right.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const Board = require("../src/board.js");

const task = (id, over = {}) => ({
  id,
  text: `task ${id}`,
  priority: "",
  status: "assigned",
  assignee: "",
  createdAt: 0,
  ...over,
});

/* ── Columns and their order ────────────────────────────────── */

test("the columns run assigned, completed, submitted", () => {
  assert.deepEqual(Board.STATUSES, ["assigned", "completed", "submitted"]);
});

test("next and prev step through the columns and stop at the ends", () => {
  assert.equal(Board.next("assigned"), "completed");
  assert.equal(Board.next("completed"), "submitted");
  assert.equal(Board.next("submitted"), null);
  assert.equal(Board.prev("submitted"), "completed");
  assert.equal(Board.prev("completed"), "assigned");
  assert.equal(Board.prev("assigned"), null);
});

/* ── Normalising stored tasks ───────────────────────────────── */

test("a task with no status starts in assigned", () => {
  assert.equal(Board.normalize({ id: "a", text: "x" }).status, "assigned");
});

test("a list-era task that was ticked off lands in completed", () => {
  const t = Board.normalize({ id: "a", text: "x", done: true });
  assert.equal(t.status, "completed");
  assert.equal("done" in t, false, "the old flag is dropped");
});

test("an unknown status is treated as assigned rather than lost", () => {
  // A task in no column would be saved, counted and never shown.
  assert.equal(Board.normalize(task("a", { status: "bogus" })).status, "assigned");
});

test("normalize trims the assignee and defaults it to empty", () => {
  assert.equal(Board.normalize({ id: "a", text: "x" }).assignee, "");
  assert.equal(Board.normalize(task("a", { assignee: "  Asha " })).assignee, "Asha");
});

/* ── Moving ─────────────────────────────────────────────────── */

test("move changes the status and puts the task first", () => {
  const tasks = [task("a"), task("b"), task("c")];
  const out = Board.move(tasks, "c", "completed");

  assert.deepEqual(out.map((t) => t.id), ["c", "a", "b"]);
  assert.equal(out[0].status, "completed");
});

test("move does not mutate the list it was given", () => {
  const tasks = [task("a"), task("b")];
  Board.move(tasks, "b", "submitted");
  assert.equal(tasks[1].status, "assigned");
  assert.deepEqual(tasks.map((t) => t.id), ["a", "b"]);
});

test("moving to the column a task is already in changes nothing", () => {
  // Dropping a card back where it came from must not reorder or save.
  const tasks = [task("a"), task("b")];
  assert.equal(Board.move(tasks, "b", "assigned"), tasks);
});

test("moving to a column that does not exist changes nothing", () => {
  const tasks = [task("a")];
  assert.equal(Board.move(tasks, "a", "archived"), tasks);
  assert.equal(Board.move(tasks, "a", null), tasks);
});

test("moving a task that does not exist changes nothing", () => {
  const tasks = [task("a")];
  assert.equal(Board.move(tasks, "zz", "completed"), tasks);
});

/* ── Assignees ──────────────────────────────────────────────── */

test("assign sets a trimmed name on one task only", () => {
  const out = Board.assign([task("a"), task("b")], "b", "  Ravi  ");
  assert.equal(out[0].assignee, "");
  assert.equal(out[1].assignee, "Ravi");
});

test("assigning the name a task already has changes nothing", () => {
  const tasks = [task("a", { assignee: "Ravi" })];
  assert.equal(Board.assign(tasks, "a", "Ravi "), tasks);
});

test("people lists each name once, ignoring case, alphabetically", () => {
  const tasks = [
    task("a", { assignee: "ravi" }),
    task("b", { assignee: "Asha" }),
    task("c", { assignee: "Ravi" }),
    task("d", { assignee: "" }),
  ];
  // The first spelling seen is the one kept.
  assert.deepEqual(Board.people(tasks), ["Asha", "ravi"]);
});

/* ── Filtering ──────────────────────────────────────────────── */

test("columns splits tasks by status", () => {
  const cols = Board.columns([
    task("a"),
    task("b", { status: "completed" }),
    task("c", { status: "submitted" }),
    task("d"),
  ]);
  assert.deepEqual(cols.assigned.map((t) => t.id), ["a", "d"]);
  assert.deepEqual(cols.completed.map((t) => t.id), ["b"]);
  assert.deepEqual(cols.submitted.map((t) => t.id), ["c"]);
});

test("each column sorts by priority, keeping order within a priority", () => {
  const cols = Board.columns([
    task("a", { priority: "low" }),
    task("b"),
    task("c", { priority: "high" }),
    task("d", { priority: "low" }),
    task("e", { priority: "medium" }),
  ]);
  assert.deepEqual(cols.assigned.map((t) => t.id), ["c", "e", "a", "d", "b"]);
});

test("search matches the task text or the assignee, ignoring case", () => {
  const tasks = [
    task("a", { text: "Write the report" }),
    task("b", { text: "Fix login", assignee: "Reshma" }),
    task("c", { text: "Call vendor" }),
  ];
  const ids = (q) => Board.columns(tasks, { search: q }).assigned.map((t) => t.id);

  assert.deepEqual(ids("REPORT"), ["a"]);
  assert.deepEqual(ids("resh"), ["b"]);
  assert.deepEqual(ids("  "), ["a", "b", "c"], "a blank search shows everything");
});

test("the person filter shows one person's tasks, ignoring case", () => {
  const tasks = [
    task("a", { assignee: "Ravi" }),
    task("b", { assignee: "Asha" }),
    task("c", { assignee: "ravi", status: "submitted" }),
  ];
  const cols = Board.columns(tasks, { person: "RAVI" });
  assert.deepEqual(cols.assigned.map((t) => t.id), ["a"]);
  assert.deepEqual(cols.submitted.map((t) => t.id), ["c"]);
});

test("the unassigned filter shows only tasks with no assignee", () => {
  const tasks = [task("a", { assignee: "Ravi" }), task("b")];
  const cols = Board.columns(tasks, { person: Board.UNASSIGNED });
  assert.deepEqual(cols.assigned.map((t) => t.id), ["b"]);
});

test("everyone is the default and shows all tasks", () => {
  const tasks = [task("a", { assignee: "Ravi" }), task("b")];
  assert.equal(Board.columns(tasks, { person: Board.EVERYONE }).assigned.length, 2);
  assert.equal(Board.columns(tasks).assigned.length, 2);
});

test("a person filter whose last task is gone falls back to everyone", () => {
  // Otherwise deleting someone's last task leaves an empty board and a
  // filter chip that is no longer drawn, so no way to see it was the cause.
  const tasks = [task("a", { assignee: "Asha" })];
  assert.equal(Board.resolvePerson("Ravi", tasks), Board.EVERYONE);
  assert.equal(Board.resolvePerson("asha", tasks), "asha");
  assert.equal(Board.resolvePerson(Board.UNASSIGNED, tasks), Board.UNASSIGNED);
  assert.equal(Board.resolvePerson(Board.EVERYONE, tasks), Board.EVERYONE);
});

/* ── Progress ───────────────────────────────────────────────── */

test("progress counts submitted tasks against the total", () => {
  const p = Board.progress([
    task("a"),
    task("b", { status: "completed" }),
    task("c", { status: "submitted" }),
    task("d", { status: "submitted" }),
  ]);
  assert.deepEqual(p, { submitted: 2, total: 4, pct: 50 });
});

test("progress of an empty board is zero, not NaN", () => {
  assert.deepEqual(Board.progress([]), { submitted: 0, total: 0, pct: 0 });
});
