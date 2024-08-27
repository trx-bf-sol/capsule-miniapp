import { CloudStorageKey, CloudStorageValue, telegramCloudStorage } from "./telegramCloudStorage";

const INITIAL_CHUNK_COUNT = 32;
const MAX_RETRIES = 256;

export type LogFunction = (message: string, type: "info" | "error" | "success") => void;
export type ErrorHandler = (errorMessage: string) => void;

const storeWithChunking = async (
  key: CloudStorageKey,
  value: CloudStorageValue,
  log: LogFunction,
  handleError: ErrorHandler
): Promise<number> => {
  const store = (k: CloudStorageKey, v: CloudStorageValue): Promise<void> => {
    return new Promise((resolve, reject) => {
      telegramCloudStorage.setItem(k, v, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };

  const storeChunks = async (baseKey: CloudStorageKey, chunks: string[], depth: number = 0): Promise<number> => {
    if (depth > MAX_RETRIES) {
      throw new Error(`Failed to store after ${MAX_RETRIES} splitting attempts`);
    }

    const failedChunks: { index: number; value: string }[] = [];

    await Promise.all(
      chunks.map(async (chunk, index) => {
        const chunkKey = `${baseKey}_chunk_${index}`;
        try {
          await store(chunkKey, chunk);
        } catch (error) {
          failedChunks.push({ index, value: chunk });
        }
      })
    );

    if (failedChunks.length === 0) {
      return chunks.length;
    }

    const newChunks: string[] = chunks.filter((_, index) => !failedChunks.some((fc) => fc.index === index));

    for (const { value } of failedChunks) {
      const midPoint = Math.ceil(value.length / 2);
      newChunks.push(value.slice(0, midPoint), value.slice(midPoint));
    }

    return storeChunks(baseKey, newChunks, depth + 1);
  };

  try {
    const initialChunkSize = Math.ceil(value.length / INITIAL_CHUNK_COUNT);
    const initialChunks = Array.from({ length: INITIAL_CHUNK_COUNT }, (_, i) =>
      value.slice(i * initialChunkSize, (i + 1) * initialChunkSize)
    ).filter((chunk) => chunk.length > 0);

    const totalChunks = await storeChunks(key, initialChunks);
    await store(`${key}_meta`, JSON.stringify({ totalChunks }));
    log(`Successfully stored "${key}" in ${totalChunks} chunks`, "success");
    return totalChunks;
  } catch (error) {
    handleError(`Failed to store "${key}": ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
};

const retrieveChunkedData = async (
  key: CloudStorageKey,
  log: LogFunction,
  handleError: ErrorHandler
): Promise<CloudStorageValue> => {
  const retrieve = (k: CloudStorageKey): Promise<CloudStorageValue | undefined> => {
    return new Promise((resolve, reject) => {
      telegramCloudStorage.getItem(k, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  };

  try {
    const metaData = await retrieve(`${key}_meta`);
    if (!metaData) {
      throw new Error(`No metadata found for key ${key}`);
    }
    const { totalChunks } = JSON.parse(metaData) as { totalChunks: number };
    log(`Retrieving data for "${key}" (${totalChunks} chunks)`, "info");

    const chunks = await Promise.all(Array.from({ length: totalChunks }, (_, i) => retrieve(`${key}_chunk_${i}`)));

    const data = chunks.join("");
    log(`Successfully retrieved and recombined data for "${key}"`, "success");

    return data;
  } catch (error) {
    handleError(`Failed to retrieve data for "${key}": ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
};

const clearChunkedStorage = async (log: LogFunction, handleError: ErrorHandler): Promise<void> => {
  const getKeys = (): Promise<string[]> => {
    return new Promise((resolve, reject) => {
      telegramCloudStorage.getKeys((error, result) => {
        if (error) reject(error);
        else resolve(result || []);
      });
    });
  };

  const getItem = (key: string): Promise<string | undefined> => {
    return new Promise((resolve, reject) => {
      telegramCloudStorage.getItem(key, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  };

  const removeItem = (key: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      telegramCloudStorage.removeItem(key, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };

  try {
    log("Starting storage clearance...", "info");
    const keys = await getKeys();

    for (const key of keys) {
      if (key.endsWith("_meta")) {
        const baseKey = key.replace("_meta", "");
        const metaData = await getItem(key);

        if (metaData) {
          const { totalChunks } = JSON.parse(metaData);
          log(`Clearing ${totalChunks} chunks for ${baseKey}...`, "info");

          for (let i = 0; i < totalChunks; i++) {
            await removeItem(`${baseKey}_chunk_${i}`);
          }
        }
      }
      await removeItem(key);
    }

    log("Storage cleared successfully", "success");
  } catch (error) {
    handleError(`Error clearing storage: ${error instanceof Error ? error.message : String(error)}`);
    throw error; // Re-throw the error so the caller can handle it if needed
  }
};

export { storeWithChunking, retrieveChunkedData, clearChunkedStorage };