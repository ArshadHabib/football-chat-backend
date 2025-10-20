const ChatRoomModel = require("./model");

async function createChatRoomService(roomId) {
  try {
    const existingRoom = await ChatRoomModel.findOne({ roomId });
    if (existingRoom) {
      console.error(`Chat room with roomId '${roomId}' already exists`);
      return null;
    }
    const newChatRoom = new ChatRoomModel({
      roomId: roomId,
      messages: [],
    });
    await newChatRoom.save();
    console.log(`DB Chat room created successfully with roomId: ${roomId}`);
    return true;
  } catch (error) {
    return null;
  }
}

async function deleteChatRoomService(roomId) {
  try {
    const deletedRoom = await ChatRoomModel.findOneAndDelete({ roomId });
    if (!deletedRoom) {
      console.error(`Chat room with roomId '${roomId}' not found`);
      return null;
    }
    console.log(`DB Chat room deleted successfully with roomId: ${roomId}`);
    return true;
  } catch (error) {
    return null;
  }
}

async function deleteAllDBChatRoomService() {
  try {
    const deletedRooms = await ChatRoomModel.deleteMany({});
    if (deletedRooms?.deletedCount === 0) {
      console.error("DB No chat rooms found to delete");
      return null;
    }
    console.log(`DB All chat rooms deleted successfully`);
    return true;
  } catch (error) {
    console.error("DB Error deleting chat rooms:", error);
    return null;
  }
}

async function saveChatMessageService(roomId, messageData) {
  try {
    // Find the chat room and push the new message
    await ChatRoomModel.findOneAndUpdate(
      { roomId },
      {
        $push: {
          messages: {
            ...messageData,
            timestamp: new Date(),
          },
        },
      }
    );
    console.log(`Message saved successfully in room: ${roomId}`);
    return true;
  } catch (error) {
    console.error(`Error saving message in room ${roomId}:`, error.message);
    return null;
  }
}

async function retrieveRoomMessagesService(roomId, options = {}) {
  try {
    const {
      limit = 50,
      skip = 0,
      sort = { timestamp: -1 }, // Default: latest messages first
    } = options;

    const chatRoom = await ChatRoomModel.findOne(
      { roomId }
      //   {
      //     messages: {
      //       $slice: [skip, limit], // Pagination: skip and limit
      //     },
      //   }
    );

    if (!chatRoom) {
      console.error(`Chat room with roomId '${roomId}' not found`);
      return null;
    }

    // Sort the messages if needed (since $slice doesn't maintain sort order with pagination)
    let messages = chatRoom?.messages?.length ? chatRoom?.messages : [];

    console.log(`Retrieved ${messages.length} messages from room: ${roomId}`);
    return messages;
  } catch (error) {
    console.error(
      `Error retrieving messages from room ${roomId}:`,
      error.message
    );
    return null;
  }
}

async function deleteAllChatMessagesService() {
  try {
    await ChatRoomModel.deleteMany({});
    console.log(`DB Chat collection wiped successfully.`);
    return true;
  } catch (error) {
    console.error("Error wiping chat collection:", error.message);
    return null;
  }
}

module.exports = {
  createChatRoomService,
  deleteChatRoomService,
  saveChatMessageService,
  retrieveRoomMessagesService,
  deleteAllChatMessagesService,
  deleteAllDBChatRoomService,
};
