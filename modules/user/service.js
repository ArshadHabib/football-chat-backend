const User = require("./model");

async function createUser(name, clientIp) {
  const user = new User({
    name,
    ipAddress: clientIp === "127.0.0.1" ? "" : clientIp || "",
  });
  await user.save();
  return user;
}

async function findUserByName(name) {
  return await User.findOne({ name }).lean();
}

async function findUserByIp(ipAddress) {
  if (!ipAddress) return null;
  return await User.findOne({ ipAddress }).lean();
}

async function findBannedUserByIp(ipAddress) {
  if (!ipAddress) return null;
  return await User.findOne({ ipAddress, isBanned: true }).lean();
}

async function findUserById(id) {
  return await User.findById(id).lean();
}

async function updateUser(name, updatedFields) {
  return await User.findOneAndUpdate(
    { name },
    { ...updatedFields },
    { new: true }
  );
}

async function banAllUsersByIp(ipAddress) {
  if (!ipAddress) return [];
  const users = await User.find({ ipAddress }, { name: 1 }).lean();
  if (users.length === 0) return [];
  await User.updateMany({ ipAddress }, { isBanned: true });
  return users.map((u) => u.name);
}

module.exports = {
  createUser,
  findUserByName,
  findUserById,
  updateUser,
  findUserByIp,
  findBannedUserByIp,
  banAllUsersByIp,
};
