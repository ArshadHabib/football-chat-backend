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
  return await User.findOne({ name });
}

async function findUserByIp(ipAddress) {
  if (!ipAddress) return null;
  return await User.findOne({ ipAddress });
}

async function findBannedUserByIp(ipAddress) {
  if (!ipAddress) return null;
  return await User.findOne({ ipAddress, isBanned: true });
}

async function findUserById(id) {
  return await User.findById(id);
}

async function updateUser(name, updatedFields) {
  return await User.findOneAndUpdate(
    { name },
    { ...updatedFields },
    { new: true }
  );
}

module.exports = {
  createUser,
  findUserByName,
  findUserById,
  updateUser,
  findUserByIp,
  findBannedUserByIp,
};
