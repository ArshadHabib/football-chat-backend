const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    const poolSize = parseInt(process.env.MONGO_POOL_SIZE, 10) || 10;
    const minPoolSize = parseInt(process.env.MONGO_MIN_POOL_SIZE, 10) || 2;

    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: Math.max(1, Math.min(poolSize, 100)),
      minPoolSize: Math.max(0, Math.min(minPoolSize, poolSize)),
      serverSelectionTimeoutMS: 10000,
    });
    // await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB connected...");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    // process.exit(1);
  }
};

module.exports = connectDB;
