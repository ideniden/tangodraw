import {ExcalidrawElement, FileId} from "../../element/types";
import {getSceneVersion} from "../../element";
import Portal from "../collab/Portal";
import {restoreElements} from "../../data/restore";
import {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "../../types";
import {DATABASE_STORAGE_PREFIXES, FILE_CACHE_MAX_AGE_SEC} from "../app_constants";
import {decompressData} from "../../data/encode";
import {encryptData, decryptData} from "../../data/encryption";
import {MIME_TYPES} from "../../constants";
import {reconcileElements} from "../collab/reconciliation";
import {getSyncableElements, SyncableExcalidrawElement} from ".";
import {createClient} from '@supabase/supabase-js';
// private
// -----------------------------------------------------------------------------

const supabaseUrl = process.env.REACT_APP_DATABASE_URL || '';
const supabaseKey = process.env.REACT_APP_DATABASE_KEY || '';
if (!supabaseUrl || !supabaseKey) {
  console.error('supabaseUrl or supabaseKey is empty !!!', process.env.REACT_APP_DATABASE_URL, process.env.REACT_APP_DATABASE_KEY);
}
// const supabaseBucket = "image"
const supabase = createClient(
  supabaseUrl,
  supabaseKey);

class DatabaseSceneVersionCache {
  private static cache = new WeakMap<SocketIOClient.Socket, number>();
  static get = (socket: SocketIOClient.Socket) => {
    return DatabaseSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: SocketIOClient.Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    DatabaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToDatabase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return DatabaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToDatabase = async ({
                                            prefix,
                                            files,
                                          }: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  // const firebase = await loadFirebaseStorage();

  const erroredFiles = new Map<FileId, true>();
  const savedFiles = new Map<FileId, true>();

  await Promise.all(
    files.map(async ({id, buffer}) => {
      try {
        // const supabase = createClient(
        //   supabaseUrl,
        //   supabaseKey);
        await supabase.storage.from(DATABASE_STORAGE_PREFIXES.collabBucket).upload(
          `${prefix}/${id}`,
          new Blob([buffer], {
            type: MIME_TYPES.binary,
          }),
          {
            cacheControl: `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
          },);
        savedFiles.set(id, true);
      } catch (error: any) {
        console.log('upload error', error);
        erroredFiles.set(id, true);
      }
    }),
  );

  return {savedFiles, erroredFiles};
};

export const loadFilesFromDatabase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {

        const url = `${supabaseUrl}/storage/v1/object/${DATABASE_STORAGE_PREFIXES.collabBucket}/${prefix}/${id}`
        // console.log('url', url)
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${supabaseKey}`,
          }
        });
        // console.log('response', response)
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();
          const {data, metadata} = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return {loadedFiles, erroredFiles};
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const {encryptedBuffer, iv} = await encryptData(key, encoded);

  return {ciphertext: encryptedBuffer, iv};
};

const decryptElements = async (
  // data: FirebaseStoredScene,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

const createDatabaseSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = getSceneVersion(elements);
  const {ciphertext, iv} = await encryptElements(roomKey, elements);

  const ciphertextArray = new Uint8Array(ciphertext);

  const obj = {
    sceneVersion,
    ciphertext: ciphertextArray,
    iv
  };

  // console.log(`cipher obj -> `, obj)
  // console.log(`cipher json str -> ${JSON.stringify(obj)}`)
  // console.log(`cipher json obj ->`, JSON.parse(JSON.stringify(obj)))

  return obj;
};

export const saveToDatabase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const {roomId, roomKey, socket} = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToDatabase(portal, elements)
  ) {
    return false;
  }

  const savedData = await supabase
    .from('scenes')
    .select('document')
    .eq('room_id', roomId)
    .then(async (data) => {

      console.log('从协作服务器查询场景信息 -> ', data)

      if (data.data?.length === 0) {

        console.log('正在创建并保存场景信息到协作服务器...', roomId)

        const {sceneVersion, ciphertext, iv} = await createDatabaseSceneDocument(elements, roomKey);
        const {error} = await supabase.from('scenes').insert({
          room_id: roomId,
          document: {
            sceneVersion,
            ciphertext: Array.from(ciphertext),
            iv: Array.from(iv)
          }
        })
        return {
          elements,
          reconciledElements: null,
        };
      }

      console.log('正在更新 场景信息 到协作服务器...', roomId)

      const document = data.data?.[0].document
      const prevElements = getSyncableElements(
        await decryptElements(
          new Uint8Array(document.ciphertext),
          new Uint8Array(document.iv),
          roomKey),
      );

      const reconciledElements = getSyncableElements(
        reconcileElements(elements, prevElements, appState),
      );

      const {sceneVersion, ciphertext, iv} = await createDatabaseSceneDocument(
        reconciledElements,
        roomKey,
      );

      supabase
        .from('scenes')
        .update({
          document: {
            sceneVersion,
            ciphertext: Array.from(ciphertext),
            iv: Array.from(iv)
          }
        })
        .eq('room_id', roomId)
        .then((data) => {
        });

      console.log('更新 场景信息 到协作服务器完毕。', roomId)

      return {
        elements,
        reconciledElements,
      };
    });

  // console.log('savedData -> ', savedData)

  DatabaseSceneVersionCache.set(socket, savedData.elements);

  return {reconciledElements: savedData.reconciledElements};
};

export const loadFromDatabase = async (
  roomId: string,
  roomKey: string,
  socket: SocketIOClient.Socket | null,
): Promise<readonly ExcalidrawElement[] | null> => {

  const data = await supabase
    .from('scenes')
    .select('document')
    .eq('room_id', roomId);

  console.log('从协作服务器加载场景信息 -> ', data)

  const document = data.data?.[0].document
  const elements = getSyncableElements(
    await decryptElements(
      new Uint8Array(document.ciphertext),
      new Uint8Array(document.iv),
      roomKey),
  );

  if (socket) {
    DatabaseSceneVersionCache.set(socket, elements);
  }

  return restoreElements(elements, null);
};
