import test from "node:test";
import assert from "node:assert/strict";
import {
  getChecklistStats,
  hasChecklistItems,
  noteListSnippet,
  toggleTaskAtIndex,
} from "./rich-text";
import { folderTreeItems } from "./folders";

test("hasChecklistItems detects unchecked and checked markdown tasks", () => {
  assert.equal(hasChecklistItems("Just a regular paragraph"), false);
  assert.equal(hasChecklistItems("- [ ] Buy coffee\n- [x] Read book"), true);
});

test("getChecklistStats counts total and completed tasks accurately", () => {
  const md = [
    "# Grocery List",
    "- [ ] Oat milk",
    "- [x] Sourdough bread",
    "- [X] Espresso beans",
    "Regular note line",
  ].join("\n");
  assert.deepEqual(getChecklistStats(md), { total: 3, checked: 2 });
});

test("toggleTaskAtIndex toggles only the targeted task item", () => {
  const md = ["- [ ] First task", "Some text", "- [x] Second task"].join("\n");
  const afterFirst = toggleTaskAtIndex(md, 0);
  assert.equal(afterFirst, ["- [x] First task", "Some text", "- [x] Second task"].join("\n"));

  const afterSecond = toggleTaskAtIndex(afterFirst, 1);
  assert.equal(afterSecond, ["- [x] First task", "Some text", "- [ ] Second task"].join("\n"));
});

test("noteListSnippet strips markdown syntax into a clean Apple Notes list preview", () => {
  const md = "- [ ] Pack passport\n**Flight** at 9am";
  assert.equal(noteListSnippet(md), "☐ Pack passport · Flight at 9am");
  assert.equal(noteListSnippet(""), "No additional text");
});

test("folderTreeItems builds hierarchical depth and child metadata", () => {
  const rows = [
    { id: "1", name: "Work", parent_id: null },
    { id: "2", name: "Q4", parent_id: "1" },
    { id: "3", name: "Personal", parent_id: null },
  ];
  const tree = folderTreeItems(rows);
  assert.equal(tree.length, 3);
  assert.deepEqual(tree[0], {
    id: "3",
    name: "Personal",
    fullPath: "Personal",
    depth: 0,
    parent_id: null,
    hasChildren: false,
  });
  assert.deepEqual(tree[1], {
    id: "1",
    name: "Work",
    fullPath: "Work",
    depth: 0,
    parent_id: null,
    hasChildren: true,
  });
  assert.deepEqual(tree[2], {
    id: "2",
    name: "Q4",
    fullPath: "Work / Q4",
    depth: 1,
    parent_id: "1",
    hasChildren: false,
  });
});
