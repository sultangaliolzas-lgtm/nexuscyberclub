const db = require("../../lib/db");
const { requireOwner, methodGuard } = require("../../lib/guard");

// База клиентов, отсортированная по последнему визиту:
// сверху те, кто был недавно, снизу — кто пропал.
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["GET"])) return;

  const auth = await requireOwner(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  try {
    const clients = await db.listClients(200);
    res.status(200).json({ clients: clients || [] });
  } catch (err) {
    console.error("admin clients error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};
