const User = require("./model");

async function createUser(name) {
  const user = new User({
    name,
  });
  await user.save();
  return user;
}

async function findUserByName(name) {
  return await User.findOne({ name });
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
};
