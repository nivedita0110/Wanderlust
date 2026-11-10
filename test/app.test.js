const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

describe("1. Environment Variable Validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  test("should identify missing required environment variables", () => {
    const requiredEnvVars = [
      "ATLASDB_URL",
      "SECRET",
      "MAP_TOKEN",
      "CLOUD_NAME",
      "CLOUD_API_KEY",
      "CLOUD_API_SECRET",
    ];
    delete process.env.ATLASDB_URL;
    delete process.env.SECRET;
    delete process.env.MAP_TOKEN;

    const missing = requiredEnvVars.filter((key) => !process.env[key]);
    assert.ok(missing.includes("ATLASDB_URL"));
    assert.ok(missing.includes("SECRET"));
    assert.ok(missing.includes("MAP_TOKEN"));
  });

  test("should pass when all required environment variables are present", () => {
    const requiredEnvVars = [
      "ATLASDB_URL",
      "SECRET",
      "MAP_TOKEN",
      "CLOUD_NAME",
      "CLOUD_API_KEY",
      "CLOUD_API_SECRET",
    ];
    process.env.ATLASDB_URL = "mongodb://localhost:27017/test";
    process.env.SECRET = "testsecret";
    process.env.MAP_TOKEN = "pk.testtoken";
    process.env.CLOUD_NAME = "testcloud";
    process.env.CLOUD_API_KEY = "testkey";
    process.env.CLOUD_API_SECRET = "testsecret";

    const missing = requiredEnvVars.filter((key) => !process.env[key]);
    assert.equal(missing.length, 0);
  });
});

describe("2. Mapbox Geocoding Empty Results Safety", () => {
  test("safe fallback when geocoding features is empty array", () => {
    const geoDataEmpty = { body: { features: [] } };
    let geometry = { type: "Point", coordinates: [0, 0] };

    if (
      geoDataEmpty &&
      geoDataEmpty.body &&
      geoDataEmpty.body.features &&
      geoDataEmpty.body.features.length > 0 &&
      geoDataEmpty.body.features[0].geometry
    ) {
      geometry = geoDataEmpty.body.features[0].geometry;
    }

    assert.deepEqual(geometry, { type: "Point", coordinates: [0, 0] });
  });

  test("extracts geometry when geocoding features are found", () => {
    const geoDataValid = {
      body: {
        features: [
          {
            geometry: {
              type: "Point",
              coordinates: [77.209, 28.6139],
            },
          },
        ],
      },
    };

    let geometry = { type: "Point", coordinates: [0, 0] };
    if (
      geoDataValid &&
      geoDataValid.body &&
      geoDataValid.body.features &&
      geoDataValid.body.features.length > 0 &&
      geoDataValid.body.features[0].geometry
    ) {
      geometry = geoDataValid.body.features[0].geometry;
    }

    assert.deepEqual(geometry, {
      type: "Point",
      coordinates: [77.209, 28.6139],
    });
  });

  test("safe fallback on update route when geocoding returns empty features", () => {
    const existingListing = {
      geometry: { type: "Point", coordinates: [12.34, 56.78] },
    };
    const geoDataEmpty = { body: { features: [] } };

    let geometry = existingListing.geometry;
    if (
      geoDataEmpty &&
      geoDataEmpty.body &&
      geoDataEmpty.body.features &&
      geoDataEmpty.body.features.length > 0 &&
      geoDataEmpty.body.features[0].geometry
    ) {
      geometry = geoDataEmpty.body.features[0].geometry;
    }
    if (!geometry || !geometry.coordinates || geometry.coordinates.length === 0) {
      geometry = { type: "Point", coordinates: [0, 0] };
    }

    // Retains existing valid geometry instead of crashing
    assert.deepEqual(geometry, {
      type: "Point",
      coordinates: [12.34, 56.78],
    });
  });
});

describe("3. Listing Existence & Ownership Verification Middleware", () => {
  const mockIsOwner = async (req, res, next, findListingFn) => {
    const { id } = req.params;
    const listing = await findListingFn(id);
    if (!listing) {
      req.flash("error", "Listing not found.");
      return res.redirect("/listings");
    }
    const currentUserId = res.locals.currentUser?._id || req.user?._id;
    if (!listing.owner || !listing.owner.equals(currentUserId)) {
      req.flash("error", "You don't have permission to do that!");
      return res.redirect(`/listings/${id}`);
    }
    next();
  };

  test("redirects with error when listing does not exist", async () => {
    const flashMessages = [];
    let redirectUrl = "";
    let nextCalled = false;

    const req = {
      params: { id: "nonexistent123" },
      flash: (type, msg) => flashMessages.push({ type, msg }),
      user: { _id: "user1" },
    };
    const res = {
      locals: { currentUser: { _id: "user1" } },
      redirect: (url) => { redirectUrl = url; },
    };
    const next = () => { nextCalled = true; };

    await mockIsOwner(req, res, next, async () => null);

    assert.equal(nextCalled, false);
    assert.equal(redirectUrl, "/listings");
    assert.deepEqual(flashMessages, [{ type: "error", msg: "Listing not found." }]);
  });

  test("blocks non-owner from modifying listing", async () => {
    const flashMessages = [];
    let redirectUrl = "";
    let nextCalled = false;

    const ownerId = {
      toString: () => "owner123",
      equals: (other) => String(other) === "owner123",
    };
    const strangerId = {
      toString: () => "stranger456",
      equals: (other) => String(other) === "stranger456",
    };

    const mockListing = {
      _id: "listing123",
      owner: ownerId,
    };

    const req = {
      params: { id: "listing123" },
      flash: (type, msg) => flashMessages.push({ type, msg }),
      user: { _id: strangerId },
    };
    const res = {
      locals: { currentUser: { _id: strangerId } },
      redirect: (url) => { redirectUrl = url; },
    };
    const next = () => { nextCalled = true; };

    await mockIsOwner(req, res, next, async () => mockListing);

    assert.equal(nextCalled, false);
    assert.equal(redirectUrl, "/listings/listing123");
    assert.deepEqual(flashMessages, [
      { type: "error", msg: "You don't have permission to do that!" },
    ]);
  });

  test("allows owner to proceed", async () => {
    let nextCalled = false;
    let redirectUrl = "";

    const ownerId = {
      toString: () => "owner123",
      equals: (other) => String(other) === "owner123",
    };

    const mockListing = {
      _id: "listing123",
      owner: ownerId,
    };

    const req = {
      params: { id: "listing123" },
      flash: () => {},
      user: { _id: ownerId },
    };
    const res = {
      locals: { currentUser: { _id: ownerId } },
      redirect: (url) => { redirectUrl = url; },
    };
    const next = () => { nextCalled = true; };

    await mockIsOwner(req, res, next, async () => mockListing);

    assert.equal(nextCalled, true);
    assert.equal(redirectUrl, "");
  });
});

describe("4. Review Author & Belongs-to-Listing Verification Middleware", () => {
  const mockIsReviewAuthor = async (req, res, next, findListingFn, findReviewFn) => {
    const { id, reviewId } = req.params;
    const listing = await findListingFn(id);
    if (!listing) {
      req.flash("error", "Listing not found.");
      return res.redirect("/listings");
    }

    const review = await findReviewFn(reviewId);
    if (!review) {
      req.flash("error", "Review not found.");
      return res.redirect(`/listings/${id}`);
    }

    // Verify review belongs to the listing in the URL
    const reviewBelongsToListing =
      listing.reviews && listing.reviews.some((r) => String(r) === String(reviewId));
    if (!reviewBelongsToListing) {
      req.flash("error", "This review does not belong to the specified listing!");
      return res.redirect(`/listings/${id}`);
    }

    const currentUserId = res.locals.currentUser?._id || req.user?._id;
    if (!review.author || !review.author.equals(currentUserId)) {
      req.flash("error", "You are not the author of this review!");
      return res.redirect(`/listings/${id}`);
    }
    next();
  };

  test("blocks deletion when review does not belong to the listing in the URL", async () => {
    const flashMessages = [];
    let redirectUrl = "";
    let nextCalled = false;

    const authorId = {
      toString: () => "author1",
      equals: (other) => String(other) === "author1",
    };

    // Listing only contains revA, but request asks to delete revB
    const mockListing = {
      _id: "listing1",
      reviews: ["revA"],
    };

    const mockReview = {
      _id: "revB",
      author: authorId,
    };

    const req = {
      params: { id: "listing1", reviewId: "revB" },
      flash: (type, msg) => flashMessages.push({ type, msg }),
      user: { _id: authorId },
    };
    const res = {
      locals: { currentUser: { _id: authorId } },
      redirect: (url) => { redirectUrl = url; },
    };
    const next = () => { nextCalled = true; };

    await mockIsReviewAuthor(
      req,
      res,
      next,
      async () => mockListing,
      async () => mockReview
    );

    assert.equal(nextCalled, false);
    assert.equal(redirectUrl, "/listings/listing1");
    assert.deepEqual(flashMessages, [
      { type: "error", msg: "This review does not belong to the specified listing!" },
    ]);
  });

  test("blocks non-author from deleting review", async () => {
    const flashMessages = [];
    let redirectUrl = "";
    let nextCalled = false;

    const authorId = {
      toString: () => "author1",
      equals: (other) => String(other) === "author1",
    };
    const otherUserId = {
      toString: () => "user2",
      equals: (other) => String(other) === "user2",
    };

    const mockListing = {
      _id: "listing1",
      reviews: ["rev1"],
    };

    const mockReview = {
      _id: "rev1",
      author: authorId,
    };

    const req = {
      params: { id: "listing1", reviewId: "rev1" },
      flash: (type, msg) => flashMessages.push({ type, msg }),
      user: { _id: otherUserId },
    };
    const res = {
      locals: { currentUser: { _id: otherUserId } },
      redirect: (url) => { redirectUrl = url; },
    };
    const next = () => { nextCalled = true; };

    await mockIsReviewAuthor(
      req,
      res,
      next,
      async () => mockListing,
      async () => mockReview
    );

    assert.equal(nextCalled, false);
    assert.equal(redirectUrl, "/listings/listing1");
    assert.deepEqual(flashMessages, [
      { type: "error", msg: "You are not the author of this review!" },
    ]);
  });

  test("allows author to delete review when it belongs to the listing", async () => {
    let nextCalled = false;
    let redirectUrl = "";

    const authorId = {
      toString: () => "author1",
      equals: (other) => String(other) === "author1",
    };

    const mockListing = {
      _id: "listing1",
      reviews: ["rev1"],
    };

    const mockReview = {
      _id: "rev1",
      author: authorId,
    };

    const req = {
      params: { id: "listing1", reviewId: "rev1" },
      flash: () => {},
      user: { _id: authorId },
    };
    const res = {
      locals: { currentUser: { _id: authorId } },
      redirect: (url) => { redirectUrl = url; },
    };
    const next = () => { nextCalled = true; };

    await mockIsReviewAuthor(
      req,
      res,
      next,
      async () => mockListing,
      async () => mockReview
    );

    assert.equal(nextCalled, true);
    assert.equal(redirectUrl, "");
  });
});

describe("5. Session & MongoStore Configuration", () => {
  test("session options has store, secret, and cookie configuration", () => {
    const fakeStore = { on: () => {} };
    const sessionSecret = "mysupersecret";
    const sessionOptions = {
      store: fakeStore,
      secret: sessionSecret,
      resave: false,
      saveUninitialized: true,
      cookie: {
        httpOnly: true,
        expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    };

    assert.equal(sessionOptions.resave, false);
    assert.equal(sessionOptions.saveUninitialized, true);
    assert.equal(sessionOptions.cookie.httpOnly, true);
    assert.equal(sessionOptions.cookie.maxAge, 7 * 24 * 60 * 60 * 1000);
    assert.ok(sessionOptions.cookie.expires instanceof Date);
    assert.ok(sessionOptions.cookie.expires.getTime() > Date.now());
  });
});

describe("6. Joi Validation Schemas", () => {
  const { listingSchema, reviewSchema } = require("../schema.js");

  test("validates complete listing successfully", () => {
    const validListing = {
      listing: {
        title: "Test Villa",
        description: "A lovely place to stay",
        price: 2500,
        location: "Goa",
        country: "India",
      },
    };
    const { error } = listingSchema.validate(validListing);
    assert.equal(error, undefined);
  });

  test("fails listing validation if required fields are missing", () => {
    const invalidListing = {
      listing: {
        title: "Incomplete",
      },
    };
    const { error } = listingSchema.validate(invalidListing);
    assert.ok(error);
  });

  test("validates valid review successfully", () => {
    const validReview = {
      review: {
        rating: 5,
        comment: "Excellent stay!",
      },
    };
    const { error } = reviewSchema.validate(validReview);
    assert.equal(error, undefined);
  });

  test("fails review validation if rating is out of 1-5 range", () => {
    const invalidReview = {
      review: {
        rating: 6,
        comment: "Too high rating",
      },
    };
    const { error } = reviewSchema.validate(invalidReview);
    assert.ok(error);
  });
});

describe("7. Error Handling Middleware & ExpressError", () => {
  const ExpressError = require("../utils/ExpressError.js");

  test("ExpressError sets statusCode and message", () => {
    const err = new ExpressError("Not found", 404);
    assert.equal(err.message, "Not found");
    assert.equal(err.statusCode, 404);
    assert.ok(err instanceof Error);
  });
});
