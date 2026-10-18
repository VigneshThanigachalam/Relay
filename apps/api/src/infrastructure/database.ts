import mongoose from 'mongoose';
import { initializePersistence } from '../modules/persistence/initialize.js';

// Do not buffer requests against an unavailable database.
mongoose.set('bufferCommands', false);

let initialized = false;

export async function connectDatabase(uri: string): Promise<void> {
  initialized = false;
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 10000,
    maxPoolSize: 10,
    autoIndex: false,
    autoCreate: false,
  });
  try {
    await initializePersistence(mongoose.connection);
    initialized = true;
  } catch (error) {
    // A connected but unsupported database must not remain apparently ready.
    await mongoose.connection.close();
    throw error;
  }
}

export function isDatabaseReady(): boolean {
  return initialized && mongoose.connection.readyState === 1;
}

// Close only the connection this module owns. mongoose.disconnect() would also
// close unrelated test/administrative connections registered on this Mongoose instance.
export async function disconnectDatabase(): Promise<void> {
  initialized = false;
  await mongoose.connection.close();
}
