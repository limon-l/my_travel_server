const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
require("dotenv").config();

const PORT = process.env.PORT || 5000;

const app = express();
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://my-travel-client-c663.vercel.app",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.json());

if (mongoose.connection.readyState === 0) {
  mongoose
    .connect(process.env.MONGO_URI)
    .then(() => console.log("MongoDB Connected"))
    .catch((err) => console.log("DB Error:", err));
}

const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, default: "user" },
  hometown: String,
  dob: String,
});
const User = mongoose.models.User || mongoose.model("User", UserSchema);

const TourSchema = new mongoose.Schema({
  title: String,
  shortDesc: String,
  fullDesc: String,
  price: Number,
  duration: Number,
  priority: String,
  image: String,
  location: String,
});
const Tour = mongoose.models.Tour || mongoose.model("Tour", TourSchema);

const BookingSchema = new mongoose.Schema({
  user: { type: String, ref: "User" },
  tour: { type: mongoose.Schema.Types.ObjectId, ref: "Tour" },
  tourTitle: String,
  tourImage: String,
  startDate: Date,
  endDate: Date,
  totalPrice: Number,
  status: { type: String, default: "Confirmed" },
  createdAt: { type: Date, default: Date.now },
});
const Booking =
  mongoose.models.Booking || mongoose.model("Booking", BookingSchema);

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    if (email === "admin@wanderlust.com" && password === "admin123") {
      return res.json({
        id: "admin_id",
        name: "Super Admin",
        email: "admin@wanderlust.com",
        role: "admin",
      });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "User not found" });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ error: "Invalid password" });

    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: "user",
    });
  } catch (error) {
    res.status(500).json({ error: "Login error" });
  }
});

app.post("/api/register", async (req, res) => {
  const { name, email, password, hometown, dob } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      name,
      email,
      password: hashedPassword,
      hometown,
      dob,
    });
    await newUser.save();
    res.status(201).json({ message: "User registered" });
  } catch (error) {
    res.status(500).json({ error: "Email already exists" });
  }
});

app.get("/api/tours", async (req, res) => {
  try {
    const tours = await Tour.find();
    res.json(tours);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch tours" });
  }
});

app.get("/api/tours/:id", async (req, res) => {
  try {
    const tour = await Tour.findById(req.params.id);
    res.json(tour);
  } catch (e) {
    res.status(404).json({ error: "Tour not found" });
  }
});

app.post("/api/tours", async (req, res) => {
  try {
    const newTour = new Tour(req.body);
    await newTour.save();
    res.json(newTour);
  } catch (e) {
    res.status(500).json({ error: "Failed to add tour" });
  }
});

app.delete("/api/tours/:id", async (req, res) => {
  try {
    await Tour.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete" });
  }
});

app.post("/api/bookings", async (req, res) => {
  const { userId, tourId, startDate, duration, price, tourTitle, tourImage } =
    req.body;

  try {
    const start = new Date(startDate);
    const end = new Date(start);
    end.setDate(start.getDate() + parseInt(duration));

    const overlap = await Booking.findOne({
      user: userId,
      $or: [
        { startDate: { $lt: end, $gte: start } },
        { endDate: { $gt: start, $lte: end } },
        { startDate: { $lte: start }, endDate: { $gte: end } },
      ],
    });

    if (overlap) {
      return res.status(409).json({
        error: "You already have a trip booked during these dates!",
      });
    }

    const newBooking = new Booking({
      user: userId,
      tour: tourId,
      tourTitle,
      tourImage,
      startDate: start,
      endDate: end,
      totalPrice: price,
    });

    await newBooking.save();
    res.json({ message: "Booking confirmed!" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Booking failed" });
  }
});

app.get("/api/bookings/:userId", async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.params.userId }).sort({
      startDate: 1,
    });
    res.json(bookings);
  } catch (error) {
    res.status(500).json({ error: "Fetch failed" });
  }
});

app.delete("/api/bookings/:id", async (req, res) => {
  await Booking.findByIdAndDelete(req.params.id);
  res.json({ message: "Booking cancelled" });
});

app.get("/api/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

app.put("/api/users/:id", async (req, res) => {
  const { name, hometown, dob } = req.body;
  try {
    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      { name, hometown, dob },
      { new: true }
    ).select("-password");
    res.json(updatedUser);
  } catch (error) {
    res.status(500).json({ error: "Failed to update profile" });
  }
});

app.get("/api/seed", async (req, res) => {
  const tours = [
    {
      title: "Santorini Sunset Bliss",
      location: "Greece",
      price: 2400,
      duration: 7,
      priority: "Premium",
      image:
        "https://media.printler.com/media/photo/173450.jpg?rmode=crop&width=638&height=900",
      shortDesc: "White domes and blue seas.",
      fullDesc: "Explore the magical island of Santorini...",
    },
    {
      title: "Kyoto Cherry Blossoms",
      location: "Japan",
      price: 3200,
      duration: 10,
      priority: "VIP",
      image:
        "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?q=80&w=800",
      shortDesc: "Springtime magic in Japan.",
      fullDesc: "Walk through ancient temples...",
    },
    {
      title: "Swiss Alps Skiing",
      location: "Switzerland",
      price: 4500,
      duration: 8,
      priority: "VIP",
      image:
        "https://images.unsplash.com/photo-1531366936337-7c912a4589a7?q=80&w=800",
      shortDesc: "Luxury ski resort experience.",
      fullDesc: "Top tier skiing in the Alps...",
    },
    {
      title: "Bali Tropical Escape",
      location: "Indonesia",
      price: 1200,
      duration: 6,
      priority: "Standard",
      image:
        "https://images.unsplash.com/photo-1537996194471-e657df975ab4?q=80&w=800",
      shortDesc: "Beaches, temples and jungles.",
      fullDesc: "Relax in Ubud and Seminyak...",
    },
    {
      title: "Machu Picchu Hike",
      location: "Peru",
      price: 1800,
      duration: 5,
      priority: "Premium",
      image:
        "https://images.unsplash.com/photo-1526392060635-9d6019884377?q=80&w=800",
      shortDesc: "The lost city of Incas.",
      fullDesc: "A guided trek to history...",
    },
    {
      title: "Safari in Serengeti",
      location: "Tanzania",
      price: 5000,
      duration: 12,
      priority: "VIP",
      image:
        "https://images.unsplash.com/photo-1516426122078-c23e76319801?q=80&w=800",
      shortDesc: "Witness the Big Five.",
      fullDesc: "Luxury tents and game drives...",
    },
    {
      title: "New York City Lights",
      location: "USA",
      price: 2100,
      duration: 5,
      priority: "Standard",
      image:
        "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRZOlHSl4k1inEdM4UTWuYLa1Kes5ozV_C41g&s",
      shortDesc: "The city that never sleeps.",
      fullDesc: "Broadway, Times Square, and more...",
    },
    {
      title: "Parisian Romance",
      location: "France",
      price: 2800,
      duration: 7,
      priority: "Premium",
      image:
        "https://images.unsplash.com/photo-1502602898657-3e91760cbb34?q=80&w=800",
      shortDesc: "Love in the air.",
      fullDesc: "Eiffel tower dinners and Louvre tours...",
    },
    {
      title: "Iceland Northern Lights",
      location: "Iceland",
      price: 3500,
      duration: 6,
      priority: "Premium",
      image:
        "https://images.unsplash.com/photo-1476610182048-b716b8518aae?q=80&w=800",
      shortDesc: "Aurora Borealis hunt.",
      fullDesc: "Glaciers, geysers and lights...",
    },
    {
      title: "Dubai Desert Safari",
      location: "UAE",
      price: 1500,
      duration: 5,
      priority: "Standard",
      image:
        "https://media2.thrillophilia.com/images/photos/000/124/492/original/1527232809_shutterstock_705430021_jpg?width=975&height=600",
      shortDesc: "Luxury amidst sand dunes.",
      fullDesc: "Burj Khalifa and desert camping...",
    },
    {
      title: "Great Barrier Reef",
      location: "Australia",
      price: 3100,
      duration: 9,
      priority: "Premium",
      image:
        "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTqgoaY5dubp6gP1vLAivq2pt5jzGb6N3HFiA&s",
      shortDesc: "Dive into the blue.",
      fullDesc: "Snorkeling and island hopping...",
    },
    {
      title: "Amalfi Coast Drive",
      location: "Italy",
      price: 2900,
      duration: 7,
      priority: "VIP",
      image: "https://duespaghetti.com/wp-content/uploads/2023/07/1-1.jpg",
      shortDesc: "Scenic coastal beauty.",
      fullDesc: "Positano, Amalfi and Ravello...",
    },
    {
      title: "Cappadocia Hot Air Balloons",
      location: "Turkey",
      price: 1600,
      duration: 4,
      priority: "Standard",
      image:
        "https://images.unsplash.com/photo-1641128324972-af3212f0f6bd?q=80&w=800",
      shortDesc: "Fairy chimneys from above.",
      fullDesc: "Sunrise balloon rides...",
    },
    {
      title: "Pyramids of Giza",
      location: "Egypt",
      price: 1400,
      duration: 6,
      priority: "Standard",
      image:
        "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcToxbohCJNWQPAWElPJf8na8f-iza-RCyrrtQ&s",
      shortDesc: "Ancient wonders.",
      fullDesc: "Cairo, Luxor and the Nile...",
    },
    {
      title: "Maldives Water Villa",
      location: "Maldives",
      price: 6000,
      duration: 5,
      priority: "VIP",
      image:
        "https://images.unsplash.com/photo-1514282401047-d79a71a590e8?q=80&w=800",
      shortDesc: "Ultimate luxury.",
      fullDesc: "Private pool over the ocean...",
    },
    {
      title: "Banff National Park",
      location: "Canada",
      price: 2200,
      duration: 7,
      priority: "Premium",
      image:
        "https://cdn.britannica.com/71/94371-050-293AE931/Mountains-region-Ten-Peaks-Moraine-Lake-Alberta.jpg",
      shortDesc: "Mountain lakes and bears.",
      fullDesc: "Hiking in the Rockies...",
    },
    {
      title: "Rio de Janeiro Carnival",
      location: "Brazil",
      price: 2000,
      duration: 5,
      priority: "Standard",
      image:
        "https://images.unsplash.com/photo-1483729558449-99ef09a8c325?q=80&w=800",
      shortDesc: "Samba and sun.",
      fullDesc: "Copacabana and Christ the Redeemer...",
    },
    {
      title: "Cape Town Explorer",
      location: "South Africa",
      price: 2300,
      duration: 8,
      priority: "Premium",
      image:
        "https://images.unsplash.com/photo-1580060839134-75a5edca2e99?q=80&w=800",
      shortDesc: "Table mountain views.",
      fullDesc: "City, wine and penguins...",
    },
    {
      title: "Scottish Highlands",
      location: "UK",
      price: 1900,
      duration: 6,
      priority: "Standard",
      image:
        "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR8Cn-x4APG7h5ihs2oR3k2lTyS6zoUCl4Irw&s",
      shortDesc: "Castles and Lochs.",
      fullDesc: "Edinburgh to Inverness...",
    },
    {
      title: "Petra by Night",
      location: "Jordan",
      price: 1700,
      duration: 5,
      priority: "Standard",
      image:
        "https://dynamic-media-cdn.tripadvisor.com/media/photo-o/2a/75/2c/61/petra-by-night-with-candles.jpg?w=1200&h=1200&s=1",
      shortDesc: "The Rose City.",
      fullDesc: "Treasury and desert jeep tours...",
    },
    {
      title: "Grand Canyon Helicopter",
      location: "USA",
      price: 2600,
      duration: 4,
      priority: "Premium",
      image:
        "https://images.unsplash.com/photo-1615551043360-33de8b5f410c?q=80&w=800",
      shortDesc: "Nature's masterpiece.",
      fullDesc: "Vegas and the Canyon...",
    },
    {
      title: "Venice Canal Tour",
      location: "Italy",
      price: 3000,
      duration: 6,
      priority: "VIP",
      image:
        "https://images.unsplash.com/photo-1514890547357-a9ee288728e0?q=80&w=800",
      shortDesc: "City of Water.",
      fullDesc: "Gondola rides and glass making...",
    },
    {
      title: "Hawaii Volcanoes",
      location: "USA",
      price: 3400,
      duration: 8,
      priority: "Premium",
      image:
        "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcT74ysNpkJabgtAZJITzSEI2W5UM77ceGnK2w&s",
      shortDesc: "Aloha spirit.",
      fullDesc: "Beaches and lava fields...",
    },
    {
      title: "Costa Rica Rainforest",
      location: "Costa Rica",
      price: 1800,
      duration: 7,
      priority: "Standard",
      image:
        "https://images.unsplash.com/photo-1519659528534-7fd733a832a0?q=80&w=800",
      shortDesc: "Pura Vida.",
      fullDesc: "Sloths, ziplining and beaches...",
    },
    {
      title: "Taj Mahal Visit",
      location: "India",
      price: 1100,
      duration: 5,
      priority: "Standard",
      image:
        "https://images.unsplash.com/photo-1564507592333-c60657eea523?q=80&w=800",
      shortDesc: "Symbol of Love.",
      fullDesc: "Delhi, Agra and Jaipur...",
    },
    {
      title: "Patagonia Trek",
      location: "Chile",
      price: 3600,
      duration: 10,
      priority: "VIP",
      image:
        "https://www.cascada.travel/hs-fs/hubfs/FOTOS%20CASCADA/Selecci%C3%B3n%20Mejores%20Fotos%20EcoCamp/Torres%20del%20Paine.jpg?width=1920&name=Torres%20del%20Paine.jpg",
      shortDesc: "End of the World.",
      fullDesc: "Glaciers and mountains...",
    },
    {
      title: "Vietnam Ha Long Bay",
      location: "Vietnam",
      price: 1300,
      duration: 7,
      priority: "Standard",
      image:
        "https://images.unsplash.com/photo-1528127269322-539801943592?q=80&w=800",
      shortDesc: "Emerald Waters.",
      fullDesc: "Cruise on a junk boat...",
    },
    {
      title: "Prague Old Town",
      location: "Czech Republic",
      price: 1600,
      duration: 5,
      priority: "Standard",
      image:
        "https://images.unsplash.com/photo-1519677100203-a0e668c92439?q=80&w=800",
      shortDesc: "Fairytale city.",
      fullDesc: "Charles Bridge and castles...",
    },
    {
      title: "Bora Bora Bungalow",
      location: "French Polynesia",
      price: 7000,
      duration: 6,
      priority: "VIP",
      image:
        "https://images.unsplash.com/photo-1532408840957-031d8034aeef?q=80&w=800",
      shortDesc: "Pacific Paradise.",
      fullDesc: "Crystal clear lagoon...",
    },
    {
      title: "Alaskan Cruise",
      location: "USA",
      price: 3800,
      duration: 9,
      priority: "Premium",
      image:
        "https://cdn1.alaskatravel.com/public/photos/00000160/royal-caribbean-cruises-ovation-160-1-HeroSubPage.jpg",
      shortDesc: "Wild Frontier.",
      fullDesc: "Whales and icebergs...",
    },
  ];

  await Tour.deleteMany({});
  await Tour.insertMany(tours);
  res.json({ message: "Seeded 30 Packages Successfully" });
});
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
