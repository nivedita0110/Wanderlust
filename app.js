if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

// 1. Validate required environment variables
const requiredEnvVars = [
  "ATLASDB_URL",
  "SECRET",
  "MAP_TOKEN",
  "CLOUD_NAME",
  "CLOUD_API_KEY",
  "CLOUD_API_SECRET",
];
const missingEnvVars = requiredEnvVars.filter((env) => !process.env[env]);
if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variable(s): ${missingEnvVars.join(", ")}`);
  throw new Error(`Missing required environment variable(s): ${missingEnvVars.join(", ")}`);
}

const express = require("express");
const app = express();
const mongoose = require("mongoose");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const wrapAsync = require("./utils/wrapAsync.js");
const ExpressError = require("./utils/ExpressError.js");
const passport = require("passport");
const LocalStrategy = require("passport-local").Strategy;
const session = require("express-session");
const MongoStore = require("connect-mongo");
const flash = require("connect-flash");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const mbxGeocoding = require("@mapbox/mapbox-sdk/services/geocoding");
const dbUrl = process.env.ATLASDB_URL;
const User = require("./models/user.js");
const Listing = require("./models/listing.js");
const Review = require("./models/review.js");
const { listingSchema, reviewSchema } = require("./schema.js");
const { storage } = require("./cloudConfig.js");

const upload = multer({ storage });
const mapToken = process.env.MAP_TOKEN;
const geocodingClient = mbxGeocoding({ accessToken: mapToken });

// DB connection
mongoose.connect(dbUrl)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

// App config
app.engine("ejs", ejsMate);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride("_method"));
app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser());

const store = MongoStore.create({
  mongoUrl: dbUrl,
  crypto: {
    secret: process.env.SECRET,
  },
  touchAfter: 24 * 3600,
});

store.on("error", (err) => {
  console.error("❌ Error in Mongo Session Store:", err);
});

// Session & flash
const sessionOptions = {
  store,
  secret: process.env.SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,
    expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
};
app.use(session(sessionOptions));
app.use(flash());

// Passport setup
app.use(passport.initialize());
app.use(passport.session());
passport.use(new LocalStrategy(User.authenticate()));
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

// Globals
app.use((req, res, next) => {
  res.locals.currentUser = req.user || null;
  res.locals.success = req.flash("success");
  res.locals.error = req.flash("error");
  next();
});

// Middleware
const saveRedirectUrl = (req, res, next) => {
  if (req.session.redirectUrl) {
    res.locals.redirectUrl = req.session.redirectUrl;
    delete req.session.redirectUrl;
  }
  next();
};

const isLoggedIn = (req, res, next) => {
  if (!req.isAuthenticated()) {
    if (req.method === "GET") {
      req.session.redirectUrl = req.originalUrl;
    }
    req.flash("error", "You must be logged in!");
    return res.redirect("/user/login");
  }
  next();
};

const isOwner = wrapAsync(async (req, res, next) => {
  const { id } = req.params;
  const listing = await Listing.findById(id);
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
});

const isReviewAuthor = wrapAsync(async (req, res, next) => {
  const { id, reviewId } = req.params;
  const listing = await Listing.findById(id);
  if (!listing) {
    req.flash("error", "Listing not found.");
    return res.redirect("/listings");
  }

  const review = await Review.findById(reviewId);
  if (!review) {
    req.flash("error", "Review not found.");
    return res.redirect(`/listings/${id}`);
  }

  // Verify that the review belongs to the listing in the URL
  const reviewBelongsToListing = listing.reviews && listing.reviews.some((r) => r.equals(reviewId));
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
});

const validateListing = (req, res, next) => {
  const { error } = listingSchema.validate(req.body);
  if (error) {
    const msg = error.details.map((el) => el.message).join(",");
    throw new ExpressError(msg, 400);
  }
  next();
};

const validateReview = (req, res, next) => {
  const { error } = reviewSchema.validate(req.body);
  if (error) {
    const msg = error.details.map((el) => el.message).join(",");
    throw new ExpressError(msg, 400);
  }
  next();
};

// Routes
app.get("/", (req, res) => {
  res.redirect("/listings");
});

app.get("/listings", wrapAsync(async (req, res) => {
  const allListings = await Listing.find({});
  res.render("listings/index", { allListings });
}));

app.get("/listings/new", isLoggedIn, (req, res) => {
  res.render("listings/new");
});

app.post("/listings",
  isLoggedIn,
  upload.single("listing[image]"),
  validateListing,
  wrapAsync(async (req, res) => {
    let geometry = {
      type: "Point",
      coordinates: [0, 0]
    };

    try {
      const geoData = await geocodingClient
        .forwardGeocode({
          query: req.body.listing.location,
          limit: 1
        })
        .send();

      if (geoData && geoData.body && geoData.body.features && geoData.body.features.length > 0 && geoData.body.features[0].geometry) {
        geometry = geoData.body.features[0].geometry;
      }
    } catch (err) {
      console.error("Mapbox geocoding error:", err.message);
    }

    const listing = new Listing(req.body.listing);
    listing.owner = req.user._id;
    listing.geometry = geometry;

    if (req.file) {
      listing.image = {
        url: req.file.path,
        filename: req.file.filename
      };
    } else {
      listing.image = {
        url: "https://images.unsplash.com/photo-1625505826533-5c80aca7d157?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=60",
        filename: "listingimage"
      };
    }

    await listing.save();
    req.flash("success", "New Listing Created!");
    res.redirect(`/listings/${listing._id}`);
  })
);

app.get("/listings/:id", wrapAsync(async (req, res) => {
  const { id } = req.params;
  const listing = await Listing.findById(id)
    .populate({
      path: "reviews",
      populate: { path: "author" }
    })
    .populate("owner");

  if (!listing) {
    req.flash("error", "Listing not found.");
    return res.redirect("/listings");
  }

  // Defensive check
  if (!listing.geometry || !listing.geometry.coordinates || listing.geometry.coordinates.length === 0) {
    listing.geometry = {
      type: "Point",
      coordinates: [0, 0], // Default fallback
    };
  }

  res.render("listings/show", { listing });
}));

app.get("/listings/:id/edit", isLoggedIn, isOwner, wrapAsync(async (req, res) => {
  const { id } = req.params;
  const listing = await Listing.findById(id);
  if (!listing) {
    req.flash("error", "Listing not found.");
    return res.redirect("/listings");
  }
  res.render("listings/edit", { listing });
}));

app.put("/listings/:id",
  isLoggedIn,
  isOwner,
  upload.single("listing[image]"),
  validateListing,
  wrapAsync(async (req, res) => {
    const { id } = req.params;
    const listing = await Listing.findById(id);
    if (!listing) {
      req.flash("error", "Listing not found.");
      return res.redirect("/listings");
    }

    let geometry = listing.geometry;
    try {
      const geoData = await geocodingClient
        .forwardGeocode({
          query: req.body.listing.location,
          limit: 1
        })
        .send();

      if (geoData && geoData.body && geoData.body.features && geoData.body.features.length > 0 && geoData.body.features[0].geometry) {
        geometry = geoData.body.features[0].geometry;
      }
    } catch (err) {
      console.error("Mapbox geocoding error:", err.message);
    }

    if (!geometry || !geometry.coordinates || geometry.coordinates.length === 0) {
      geometry = {
        type: "Point",
        coordinates: [0, 0]
      };
    }

    listing.title = req.body.listing.title;
    listing.description = req.body.listing.description;
    listing.price = req.body.listing.price;
    listing.location = req.body.listing.location;
    listing.country = req.body.listing.country;
    listing.geometry = geometry;

    if (req.file) {
      listing.image = {
        url: req.file.path,
        filename: req.file.filename
      };
    }

    await listing.save();

    req.flash("success", "Listing updated successfully!");
    res.redirect(`/listings/${id}`);
  })
);

app.delete("/listings/:id", isLoggedIn, isOwner, wrapAsync(async (req, res) => {
  const { id } = req.params;
  const deletedListing = await Listing.findByIdAndDelete(id);
  if (!deletedListing) {
    req.flash("error", "Listing not found.");
    return res.redirect("/listings");
  }
  req.flash("success", "Listing deleted.");
  res.redirect("/listings");
}));

// Auth routes
app.get("/user/signup", (req, res) => res.render("users/signup"));

app.post("/user/signup", wrapAsync(async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    const user = new User({ username, email });
    const registeredUser = await User.register(user, password);
    req.login(registeredUser, err => {
      if (err) return next(err);
      req.flash("success", "Welcome to Wanderlust!");
      res.redirect("/listings");
    });
  } catch (e) {
    req.flash("error", e.message);
    res.redirect("/user/signup");
  }
}));

app.get("/user/login", (req, res) => res.render("users/login"));

app.post("/user/login",
  saveRedirectUrl,
  passport.authenticate("local", {
    failureFlash: true,
    failureRedirect: "/user/login"
  }),
  (req, res) => {
    req.flash("success", "Welcome back!");
    const redirectUrl = res.locals.redirectUrl || "/listings";
    res.redirect(redirectUrl);
  }
);

app.get("/user/logout", (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.flash("success", "Logged out successfully.");
    res.redirect("/listings");
  });
});

// Review routes
app.post("/listings/:id/reviews",
  isLoggedIn,
  validateReview,
  wrapAsync(async (req, res) => {
    const listing = await Listing.findById(req.params.id);
    if (!listing) {
      req.flash("error", "Listing not found.");
      return res.redirect("/listings");
    }
    const review = new Review(req.body.review);
    review.author = req.user._id;
    await review.save();
    listing.reviews.push(review);
    await listing.save();
    req.flash("success", "Review added!");
    res.redirect(`/listings/${listing._id}`);
  })
);

app.delete("/listings/:id/reviews/:reviewId",
  isLoggedIn,
  isReviewAuthor,
  wrapAsync(async (req, res) => {
    const { id, reviewId } = req.params;
    await Listing.findByIdAndUpdate(id, { $pull: { reviews: reviewId } });
    await Review.findByIdAndDelete(reviewId);
    req.flash("success", "Review deleted.");
    res.redirect(`/listings/${id}`);
  })
);

// Informational routes for footer links
app.get("/privacy", (req, res) => {
  res.send("<h1>Privacy Policy</h1><p>Wanderlust is committed to protecting your privacy.</p><a href='/listings'>Back to Listings</a>");
});

app.get("/terms", (req, res) => {
  res.send("<h1>Terms of Service</h1><p>Welcome to Wanderlust. Please review our terms and conditions.</p><a href='/listings'>Back to Listings</a>");
});

// Error handling
app.all("*", (req, res, next) => {
  next(new ExpressError("Page not found", 404));
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  const { statusCode = 500 } = err;
  if (!err.message) err.message = "Something went wrong";
  res.status(statusCode).render("error", { err });
});

// Server
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
