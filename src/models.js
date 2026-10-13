import mongoose from "mongoose";
const { Schema } = mongoose;
const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    passwordHash: String,
    emailVerified: { type: Boolean, default: false },
    googleSubject: String,
    avatarUrl: { type: String, default: "" },
    avatarPublicId: String,
    otpHash: String,
    otpExpiresAt: Date,
    otpSentAt: Date,
    otpAttempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);
userSchema.index(
  { googleSubject: 1 },
  {
    unique: true,
    partialFilterExpression: { googleSubject: { $type: "string" } },
  },
);
const sessionSchema = new Schema({
  user: { type: Schema.Types.ObjectId, required: true, index: true },
  hash: { type: String, unique: true, required: true },
  expiresAt: { type: Date, required: true },
});
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const favoriteSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, required: true },
    movieSlug: { type: String, required: true },
    movie: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);
favoriteSchema.index({ user: 1, movieSlug: 1 }, { unique: true });
const historySchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, required: true },
    movieSlug: { type: String, required: true },
    movie: { type: Schema.Types.Mixed, required: true },
    server: { type: String, required: true },
    episode: { type: String, required: true },
    episodeName: String,
    positionMs: Number,
    durationMs: Number,
    completed: Boolean,
    watchedAt: { type: Date, required: true },
  },
  { timestamps: true },
);
historySchema.index(
  { user: 1, movieSlug: 1, server: 1, episode: 1 },
  { unique: true },
);
historySchema.index({ user: 1, watchedAt: -1 });
export const User = mongoose.model("User", userSchema);
export const Session = mongoose.model("Session", sessionSchema);
export const Favorite = mongoose.model("Favorite", favoriteSchema);
export const History = mongoose.model("History", historySchema);
const reviewSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    movieSlug: { type: String, required: true },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: Number.isInteger,
    },
    content: { type: String, default: "", maxlength: 2000 },
  },
  { timestamps: true },
);
reviewSchema.index({ user: 1, movieSlug: 1 }, { unique: true });
reviewSchema.index({ movieSlug: 1, updatedAt: -1, _id: -1 });
export const Review = mongoose.model("Review", reviewSchema);
