const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const reviewSchema = new Schema({
  comment: {
    type: String,
    trim: true,
    required: [true, "Comment cannot be blank."],
  },
  rating: {
    type: Number,
    min: [1, "Rating must be at least 1."],
    max: [5, "Rating must be at most 5."],
    required: [true, "Rating is required."],
  },
  author: {
    type: Schema.Types.ObjectId,
    ref:"User",
  },
}, { timestamps: true }); // adds createdAt and updatedAt automatically

module.exports = mongoose.model("Review", reviewSchema);
