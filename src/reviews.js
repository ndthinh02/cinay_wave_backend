import { z } from "zod";
import mongoose from "mongoose";
import { Review } from "./models.js";
import { authenticate } from "./auth.js";
import { ApiError, wrap } from "./errors.js";
import * as catalog from "./catalog.js";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/);
const input = z
  .object({
    rating: z.number().int().min(1).max(5),
    content: z
      .string()
      .max(2000)
      .transform((s) => s.trim())
      .default(""),
  })
  .strict();
const dto = (row) => ({
  id: String(row._id),
  rating: row.rating,
  content: row.content,
  updatedAt: row.updatedAt,
  author: row.user
    ? {
        id: String(row.user._id),
        name: row.user.name,
        avatarUrl: row.user.avatarUrl || "",
      }
    : { id: "", name: "Người dùng", avatarUrl: "" },
});

export function reviewRoutes(app, secret) {
  app.get(
    "/api/reviews/:movieSlug",
    wrap(async (req, res) => {
      const movieSlug = slug.parse(req.params.movieSlug);
      const query = z
        .object({ cursor: z.string().max(500).optional() })
        .parse(req.query);
      const match = { movieSlug, content: { $ne: "" } };
      if (query.cursor) {
        let cursor;
        try {
          cursor = JSON.parse(
            Buffer.from(query.cursor, "base64url").toString(),
          );
          if (
            !mongoose.isValidObjectId(cursor.id) ||
            !Number.isFinite(Date.parse(cursor.date))
          )
            throw new Error();
        } catch {
          throw new ApiError(
            400,
            "INVALID_CURSOR",
            "Trang nhận xét không hợp lệ.",
          );
        }
        match.$or = [
          { updatedAt: { $lt: new Date(cursor.date) } },
          {
            updatedAt: new Date(cursor.date),
            _id: { $lt: new mongoose.Types.ObjectId(cursor.id) },
          },
        ];
      }
      const [summary, rows] = await Promise.all([
        Review.aggregate([
          { $match: { movieSlug } },
          {
            $group: {
              _id: null,
              average: { $avg: "$rating" },
              total: { $sum: 1 },
            },
          },
        ]),
        Review.find(match)
          .sort({ updatedAt: -1, _id: -1 })
          .limit(11)
          .populate("user", "name avatarUrl")
          .lean(),
      ]);
      const items = rows.slice(0, 10);
      const last = items.at(-1);
      res.json({
        average: summary[0]?.average || 0,
        total: summary[0]?.total || 0,
        items: items.map(dto),
        nextCursor:
          rows.length > 10
            ? Buffer.from(
                JSON.stringify({
                  date: last.updatedAt.toISOString(),
                  id: String(last._id),
                }),
              ).toString("base64url")
            : null,
      });
    }),
  );
  const auth = authenticate(secret);
  app.get(
    "/api/reviews/:movieSlug/mine",
    auth,
    wrap(async (req, res) => {
      const row = await Review.findOne({
        movieSlug: slug.parse(req.params.movieSlug),
        user: req.user._id,
      })
        .populate("user", "name avatarUrl")
        .lean();
      res.json({ review: row ? dto(row) : null });
    }),
  );
  app.put(
    "/api/reviews/:movieSlug/mine",
    auth,
    wrap(async (req, res) => {
      const movieSlug = slug.parse(req.params.movieSlug);
      const data = input.parse(req.body);
      await catalog.detail(movieSlug);
      const key = { movieSlug, user: req.user._id };
      let row;
      try {
        row = await Review.findOneAndUpdate(
          key,
          { $set: data },
          { upsert: true, new: true, runValidators: true },
        );
      } catch (error) {
        if (error.code !== 11000) throw error;
        row = await Review.findOneAndUpdate(
          key,
          { $set: data },
          { new: true, runValidators: true },
        );
      }
      await row.populate("user", "name avatarUrl");
      res.json({ review: dto(row) });
    }),
  );
  app.delete(
    "/api/reviews/:movieSlug/mine",
    auth,
    wrap(async (req, res) => {
      await Review.deleteOne({
        movieSlug: slug.parse(req.params.movieSlug),
        user: req.user._id,
      });
      res.sendStatus(204);
    }),
  );
}
