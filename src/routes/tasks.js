import { Router } from "express";
import getPrisma from "../db/prisma.js";

const router = Router();

const DEFAULT_COLUMNS = [
  { key: "todo",     label: "To Do",       color: "#2B68B8", position: 0 },
  { key: "progress", label: "In Progress", color: "#D4680C", position: 1 },
  { key: "review",   label: "Review",      color: "#7E4BB3", position: 2 },
  { key: "backlog",  label: "Backlog",     color: "#6B7280", position: 3, isDefault: true },
  { key: "done",     label: "Done",        color: "#1A7A45", position: 4, isFinal: true },
];

async function ensureColumns(clientId) {
  const count = await getPrisma().taskColumn.count({ where: { clientId } });
  if (count > 0) return;
  await getPrisma().taskColumn.createMany({
    data: DEFAULT_COLUMNS.map(c => ({ ...c, clientId })),
    skipDuplicates: true,
  });
}

// GET /api/tasks — returns { columns, tasks }
router.get("/", async (req, res) => {
  try {
    await ensureColumns(req.user.clientId);
    const [columns, tasks] = await Promise.all([
      getPrisma().taskColumn.findMany({
        where: { clientId: req.user.clientId },
        orderBy: { position: "asc" },
      }),
      getPrisma().task.findMany({
        where: { clientId: req.user.clientId },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    res.json({ columns, tasks });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ─── Columns ─── */

router.post("/columns", async (req, res) => {
  try {
    const { key, label, color } = req.body;
    if (!key || !label) return res.status(400).json({ message: "key and label are required" });
    const existing = await getPrisma().taskColumn.findUnique({
      where: { clientId_key: { clientId: req.user.clientId, key } },
    });
    if (existing) return res.status(409).json({ message: "Column key already exists" });
    const max = await getPrisma().taskColumn.aggregate({
      where: { clientId: req.user.clientId },
      _max: { position: true },
    });
    const column = await getPrisma().taskColumn.create({
      data: {
        clientId: req.user.clientId,
        key, label,
        color: color || "#6B7280",
        position: (max._max.position ?? -1) + 1,
      },
    });
    res.status(201).json(column);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/columns/:id", async (req, res) => {
  try {
    const existing = await getPrisma().taskColumn.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!existing) return res.status(404).json({ message: "Column not found" });

    const { label, color, isDefault, isFinal } = req.body;
    const data = {};
    if (label !== undefined) data.label = label;
    if (color !== undefined) data.color = color;
    if (isFinal !== undefined) data.isFinal = !!isFinal;

    // Setting a new default clears others
    if (isDefault === true) {
      await getPrisma().taskColumn.updateMany({
        where: { clientId: req.user.clientId, isDefault: true },
        data: { isDefault: false },
      });
      data.isDefault = true;
    } else if (isDefault === false) {
      data.isDefault = false;
    }

    const column = await getPrisma().taskColumn.update({
      where: { id: req.params.id },
      data,
    });
    res.json(column);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.put("/columns/reorder", async (req, res) => {
  try {
    const { orderedKeys } = req.body;
    if (!Array.isArray(orderedKeys)) return res.status(400).json({ message: "orderedKeys array required" });
    await getPrisma().$transaction(
      orderedKeys.map((key, position) =>
        getPrisma().taskColumn.updateMany({
          where: { clientId: req.user.clientId, key },
          data: { position },
        })
      )
    );
    const columns = await getPrisma().taskColumn.findMany({
      where: { clientId: req.user.clientId },
      orderBy: { position: "asc" },
    });
    res.json(columns);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete("/columns/:id", async (req, res) => {
  try {
    const existing = await getPrisma().taskColumn.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!existing) return res.status(404).json({ message: "Column not found" });
    if (existing.isDefault || existing.isFinal) {
      return res.status(400).json({ message: "Cannot delete default or final column" });
    }
    const totalCols = await getPrisma().taskColumn.count({ where: { clientId: req.user.clientId } });
    if (totalCols <= 2) return res.status(400).json({ message: "Board must have at least 2 columns" });

    // Move orphaned tasks to default column (or any other column)
    const fallback = await getPrisma().taskColumn.findFirst({
      where: { clientId: req.user.clientId, NOT: { id: existing.id } },
      orderBy: [{ isDefault: "desc" }, { position: "asc" }],
    });
    if (fallback) {
      await getPrisma().task.updateMany({
        where: { clientId: req.user.clientId, columnKey: existing.key },
        data: { columnKey: fallback.key },
      });
    }
    await getPrisma().taskColumn.delete({ where: { id: existing.id } });
    res.json({ message: "Column deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ─── Tasks ─── */

router.post("/", async (req, res) => {
  try {
    const { title, columnKey, type, priority, dueDate, leadId, description } = req.body;
    if (!title) return res.status(400).json({ message: "title is required" });

    let targetColumn = columnKey;
    if (!targetColumn) {
      const defCol = await getPrisma().taskColumn.findFirst({
        where: { clientId: req.user.clientId, isDefault: true },
      });
      targetColumn = defCol?.key
        || (await getPrisma().taskColumn.findFirst({
          where: { clientId: req.user.clientId },
          orderBy: { position: "asc" },
        }))?.key;
    }
    if (!targetColumn) return res.status(400).json({ message: "No column available" });

    const task = await getPrisma().task.create({
      data: {
        clientId: req.user.clientId,
        columnKey: targetColumn,
        title,
        type: type || "Other",
        priority: priority || "Medium",
        dueDate: dueDate || null,
        leadId: leadId || null,
        description: description || null,
      },
    });
    res.status(201).json(task);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const existing = await getPrisma().task.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!existing) return res.status(404).json({ message: "Task not found" });

    const { title, columnKey, type, priority, dueDate, leadId, description } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (columnKey !== undefined) data.columnKey = columnKey;
    if (type !== undefined) data.type = type;
    if (priority !== undefined) data.priority = priority;
    if (dueDate !== undefined) data.dueDate = dueDate || null;
    if (leadId !== undefined) data.leadId = leadId || null;
    if (description !== undefined) data.description = description;

    const task = await getPrisma().task.update({
      where: { id: req.params.id },
      data,
    });
    res.json(task);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const existing = await getPrisma().task.findFirst({
      where: { id: req.params.id, clientId: req.user.clientId },
    });
    if (!existing) return res.status(404).json({ message: "Task not found" });
    await getPrisma().task.delete({ where: { id: req.params.id } });
    res.json({ message: "Task deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
