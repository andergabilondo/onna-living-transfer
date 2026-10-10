const { initializeApp, cert, deleteApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getAuth } = require("firebase-admin/auth");
const path = require("path"); // Importante: agregar para que funcionen las rutas relativas

const pathProd = path.join(__dirname, "./serviceAccountKey.json");
const pathDev = path.join(__dirname, "./serviceAccountKeyDev.json");

const databaseUrlProd =
  "https://onna-btr-default-rtdb.europe-west1.firebasedatabase.app";
const databaseUrlDev =
  "https://onna-living-dev-default-rtdb.europe-west1.firebasedatabase.app";

// 1. Inicialización de ambas apps
const sourceApp = initializeApp(
  {
    credential: cert(require(pathDev)),
    databaseURL: databaseUrlDev,
  },
  "source",
);

const targetApp = initializeApp(
  {
    credential: cert(require(pathProd)),
    databaseURL: databaseUrlProd,
  },
  "target",
);

const sourceDb = getDatabase(sourceApp);
const targetDb = getDatabase(targetApp);
const sourceAuth = getAuth(sourceApp);
const targetAuth = getAuth(targetApp);

/**
 * Configura FIREBASE_SOURCE_HASH_KEY y FIREBASE_SOURCE_SALT_SEPARATOR (base64),
 * FIREBASE_SOURCE_HASH_ROUNDS y FIREBASE_SOURCE_HASH_MEMORY_COST con los valores
 * de Authentication > configuración del hash de contraseñas del proyecto ORIGEN.
 * No guardes estos secretos en el código.
 */
function getImportOptions(users) {
  if (!users.some((user) => user.passwordHash)) return undefined;

  function base64Config(name, allowEmpty = false) {
    const value = process.env[name];
    if (allowEmpty && value === "") return Buffer.alloc(0);
    if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new Error(
        `Configura ${name} con el valor base64 del proyecto origen.`,
      );
    }
    const decoded = Buffer.from(value, "base64");
    if (
      decoded.length === 0 ||
      decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
    ) {
      throw new Error(`${name} no contiene base64 válido.`);
    }
    return decoded;
  }

  function integerConfig(name, min, max) {
    const value = process.env[name];
    const number = Number(value);
    if (
      !value ||
      !/^\d+$/.test(value) ||
      !Number.isInteger(number) ||
      number < min ||
      number > max
    ) {
      throw new Error(
        `Configura ${name} con un entero entre ${min} y ${max} del proyecto origen.`,
      );
    }
    return number;
  }

  return {
    hash: {
      algorithm: "SCRYPT",
      key: base64Config("FIREBASE_SOURCE_HASH_KEY"),
      saltSeparator: base64Config("FIREBASE_SOURCE_SALT_SEPARATOR", true),
      rounds: integerConfig("FIREBASE_SOURCE_HASH_ROUNDS", 1, 8),
      memoryCost: integerConfig("FIREBASE_SOURCE_HASH_MEMORY_COST", 1, 14),
    },
  };
}

// ==========================================
// MÓDULO 1: TRANSFERENCIA DE DATOS (Realtime DB)
// ==========================================
async function transferirDatos(path) {
  console.log(`\nIniciando transferencia de datos en el path: ${path}`);
  try {
    const snapshot = await sourceDb.ref(path).once("value");
    const data = snapshot.val();

    if (!data) {
      console.log(`No hay datos en el origen para el path: ${path}`);
      return;
    }

    if (typeof data !== "object" || Array.isArray(data)) {
      console.error(
        `❌ Error: Los datos en '${path}' no son un objeto JSON. No se puede usar .update() de forma segura.`,
      );
      return;
    }

    await targetDb.ref(path).update(data);
    console.log(
      `✅ Datos transferidos y fusionados correctamente en '${path}'.`,
    );
  } catch (error) {
    console.error(`❌ Error al transferir datos en ${path}:`, error);
  }
}

// ==========================================
// MÓDULO 2: TRANSFERENCIA DE USUARIOS (Auth)
// ==========================================

/**
 * Fusiona equipos, projectManagers y clients (datos y Auth), y después el perfil.
 * Las escrituras son secuenciales; la transferencia completa no es atómica.
 */
async function transferirPerfilYEquipos(
  uid,
  { repararExistente = false } = {},
) {
  const userPath = `users/${uid}`;
  const snapshot = await sourceDb.ref(userPath).once("value");
  const userData = snapshot.val();
  if (!userData || typeof userData !== "object" || Array.isArray(userData)) {
    throw new Error(`No existe un perfil válido en /${userPath} de origen.`);
  }

  const onnaDevices = userData.onnaDevices;
  if (
    onnaDevices != null &&
    (typeof onnaDevices !== "object" || Array.isArray(onnaDevices))
  ) {
    throw new Error(
      `/${userPath}/onnaDevices debe ser un objeto con onnaIds como claves.`,
    );
  }

  const projectManagers = userData.projectManagers;
  const clients = userData.clients;
  const relaciones = [
    {
      listado: projectManagers,
      campo: "projectManagers",
      ruta: "projectManagersData",
    },
    { listado: clients, campo: "clients", ruta: "clientsData" },
  ];
  for (const { listado, campo } of relaciones) {
    if (
      listado != null &&
      (typeof listado !== "object" || Array.isArray(listado))
    ) {
      throw new Error(
        `/${userPath}/${campo} debe ser un objeto con los UID como claves.`,
      );
    }
  }

  const onnaIds = Object.keys(onnaDevices || {});
  for (const onnaId of onnaIds) {
    const devicePath = `onna/${onnaId}`;
    const deviceSnapshot = await sourceDb.ref(devicePath).once("value");
    const deviceData = deviceSnapshot.val();
    if (
      !deviceData ||
      typeof deviceData !== "object" ||
      Array.isArray(deviceData)
    ) {
      throw new Error(
        `No existe un equipo válido en /${devicePath} de origen. Transferencia incompleta; el perfil no se ha copiado.`,
      );
    }
    await targetDb.ref(devicePath).update(deviceData);
    console.log(`Equipo /${devicePath} transferido y fusionado.`);
  }

  const cuentasTransferidas = new Set([uid]);
  for (const { listado, ruta } of relaciones) {
    for (const linkedUid of Object.keys(listado || {})) {
      const linkedPath = `${ruta}/${linkedUid}`;
      const linkedSnapshot = await sourceDb.ref(linkedPath).once("value");
      const linkedData = linkedSnapshot.val();
      if (linkedData == null) {
        console.warn(
          `⚠️ /${linkedPath} no existe en origen; se omite (sin datos ni Auth).`,
        );
        continue;
      }
      if (typeof linkedData !== "object" || Array.isArray(linkedData)) {
        throw new Error(
          `/${linkedPath} de origen no es un objeto válido. Transferencia incompleta; el perfil no se ha copiado.`,
        );
      }
      if (!cuentasTransferidas.has(linkedUid)) {
        const imported = await transferirCuentaAuth(linkedUid, {
          repararExistente,
        });
        if (!imported) {
          throw new Error(
            `No se ha transferido Auth de /${linkedPath} por un conflicto. Transferencia incompleta; el perfil no se ha copiado.`,
          );
        }
        cuentasTransferidas.add(linkedUid);
      }
      await targetDb.ref(linkedPath).update(linkedData);
      console.log(`/${linkedPath} y su cuenta Auth transferidos.`);
    }
  }

  await targetDb.ref(userPath).update(userData);
  console.log(
    `Perfil /${userPath} transferido y fusionado con ${onnaIds.length} equipos onna, ${Object.keys(projectManagers || {}).length} projectManagers y ${Object.keys(clients || {}).length} clients.`,
  );
}

function mapUserForImport(user) {
  const hasPasswordProvider = user.providerData?.some(
    (provider) => provider.providerId === "password",
  );
  if (hasPasswordProvider || user.passwordHash) {
    if (!user.passwordHash || typeof user.passwordSalt !== "string") {
      throw new Error(
        `No se pueden exportar las credenciales de ${user.uid}. Usa listUsers() con permiso firebaseauth.configs.getHashConfig en origen. Si el hash no es SCRYPT, será necesario restablecer la contraseña.`,
      );
    }
  }
  return {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    photoURL: user.photoURL,
    phoneNumber: user.phoneNumber,
    disabled: user.disabled,
    customClaims: user.customClaims,
    metadata: user.metadata,
    multiFactor: user.multiFactor,
    providerData: user.providerData?.map((provider) => ({
      uid: provider.uid,
      providerId: provider.providerId,
      email: provider.email,
      displayName: provider.displayName,
      photoURL: provider.photoURL,
    })),
    passwordHash: user.passwordHash
      ? Buffer.from(user.passwordHash, "base64")
      : undefined,
    passwordSalt: user.passwordHash
      ? Buffer.from(user.passwordSalt, "base64")
      : undefined,
  };
}

async function getUserForExport(uid) {
  let pageToken;
  do {
    const result = await sourceAuth.listUsers(1000, pageToken);
    const user = result.users.find((user) => user.uid === uid);
    if (user) return user;
    pageToken = result.pageToken;
  } while (pageToken);
  throw new Error(`El usuario ${uid} no existe en Authentication de origen.`);
}

/**
 * repararExistente permite reimportar las credenciales del origen sobre el mismo
 * UID de destino, sin borrar la cuenta. No habilitar para cuentas independientes.
 * Se aplica también a las cuentas vinculadas de projectManagers y clients.
 * Copia /users/{uid}, sus equipos, /projectManagersData/{projectManagerId}
 * y /clientsData/{clientId}, con las cuentas Auth de ambos listados.
 */
async function transferirUsuario(uid, { repararExistente = false } = {}) {
  console.log(`\nIniciando transferencia del usuario: ${uid}`);
  try {
    const imported = await transferirCuentaAuth(uid, { repararExistente });
    if (!imported) return;
    await transferirPerfilYEquipos(uid, { repararExistente });
    console.log(
      `✅ Usuario ${uid}, perfil, equipos, projectManagers y clients transferidos con éxito.`,
    );
  } catch (error) {
    console.error(`❌ Error al transferir usuario ${uid}:`, error);
  }
}

async function transferirCuentaAuth(uid, { repararExistente = false } = {}) {
  const userSource = await getUserForExport(uid);
  const userToImport = mapUserForImport(userSource);
  const importOptions = getImportOptions([userToImport]);

  let existingUser;
  try {
    existingUser = await targetAuth.getUser(uid);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
  }

  if (existingUser && !repararExistente) {
    console.warn(
      `⚠️ CONFLICTO: El UID ${uid} ya existe en destino. Para restaurar sus credenciales desde origen, usa { repararExistente: true } explícitamente.`,
    );
    return false;
  }

  if (userSource.email) {
    try {
      const emailUser = await targetAuth.getUserByEmail(userSource.email);
      if (emailUser.uid !== uid || !repararExistente) {
        console.warn(
          `⚠️ CONFLICTO: El email ${userSource.email} ya existe en destino. No se modifica otra cuenta.`,
        );
        return false;
      }
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }

  const result = await targetAuth.importUsers([userToImport], importOptions);
  if (result.failureCount > 0) {
    throw result.errors[0].error;
  }
  const importedUser = await targetAuth.getUser(uid);
  if (
    userToImport.passwordHash &&
    !importedUser.providerData.some(
      (provider) => provider.providerId === "password",
    )
  ) {
    throw new Error(
      `El usuario ${uid} existe en destino pero no tiene el proveedor correo/contraseña después de la importación.`,
    );
  }
  console.log(`Cuenta Auth ${userSource.email || uid} transferida.`);
  return true;
}

async function transferirTodosLosUsuarios() {
  console.log(`\nIniciando transferencia masiva de usuarios...`);
  try {
    let nextPageToken;
    let totalImported = 0;
    let totalFailed = 0;

    do {
      const result = await sourceAuth.listUsers(1000, nextPageToken);
      const usersToImport = result.users.map(mapUserForImport);

      const importResult = await targetAuth.importUsers(
        usersToImport,
        getImportOptions(usersToImport),
      );
      totalImported += importResult.successCount;
      totalFailed += importResult.failureCount;

      if (importResult.failureCount > 0) {
        importResult.errors.forEach((err) => {
          const failedUser = usersToImport[err.index];
          if (err.error.code === "auth/email-already-exists") {
            console.warn(
              `⚠️ CONFLICTO MASIVO: El email ${failedUser.email} ya existe en destino. (Omitido)`,
            );
          } else if (err.error.code === "auth/uid-already-exists") {
            console.warn(
              `⚠️ CONFLICTO UID: El usuario con UID ${failedUser.uid} ya existe en destino. (Omitido)`,
            );
          } else {
            console.error(
              `❌ Error con usuario ${failedUser.email}:`,
              err.error.message,
            );
          }
        });
      }
      nextPageToken = result.pageToken;
    } while (nextPageToken);

    if (totalFailed > 0) {
      console.error(
        `❌ Transferencia incompleta. Importados: ${totalImported}. Fallidos: ${totalFailed}.`,
      );
    } else {
      console.log(
        `✅ Transferencia de usuarios completada. Total importados: ${totalImported}`,
      );
    }
  } catch (error) {
    console.error(`❌ Error en la transferencia masiva:`, error);
  }
}

// ==========================================
// MÓDULO 3: MANTENIMIENTO Y LIMPIEZA
// ==========================================

/**
 * Solo lectura. Lista los clientsData cuyo mainUserId o claves de mainUsers
 * apuntan a un /users/{id} inexistente en la base de datos indicada.
 */
async function listarClientesHuerfanos(db, auth) {
  const clients = (await db.ref("clientsData").once("value")).val() || {};
  const referencias = new Map();

  for (const [clientId, data] of Object.entries(clients)) {
    if (!data || typeof data !== "object") continue;
    const ids = [];
    if (typeof data.mainUserId === "string" && data.mainUserId) {
      ids.push(["mainUserId", data.mainUserId]);
    }
    if (data.mainUsers && typeof data.mainUsers === "object") {
      for (const id of Object.keys(data.mainUsers)) ids.push(["mainUsers", id]);
    }
    referencias.set(clientId, ids);
  }

  const idsUnicos = [
    ...new Set([...referencias.values()].flat().map(([, id]) => id)),
  ];
  const existentes = new Set();
  const tamLote = 50;
  for (let i = 0; i < idsUnicos.length; i += tamLote) {
    const lote = idsUnicos.slice(i, i + tamLote);
    // limitToFirst(1) comprueba la existencia sin descargar el perfil completo.
    const resultados = await Promise.all(
      lote.map((id) => db.ref(`users/${id}`).limitToFirst(1).once("value")),
    );
    resultados.forEach((snap, idx) => {
      if (snap.exists()) existentes.add(lote[idx]);
    });
  }

  const huerfanos = [];
  for (const [clientId, ids] of referencias) {
    const faltan = ids.filter(([, id]) => !existentes.has(id));
    if (faltan.length === 0) continue;
    const totalMainUsers = ids.filter(
      ([campo]) => campo === "mainUsers",
    ).length;
    const faltanMainUsers = faltan.filter(
      ([campo]) => campo === "mainUsers",
    ).length;
    const emailBd = clients[clientId].email;
    const fila = {
      clientId,
      email: typeof emailBd === "string" ? emailBd : "",
      tieneAuth: null,
      mainUserIdInexistente:
        faltan.find(([campo]) => campo === "mainUserId")?.[1] || "",
      mainUsersInexistentes: faltan
        .filter(([campo]) => campo === "mainUsers")
        .map(([, id]) => id)
        .join(", "),
      sinNingunMainUserValido:
        ids.length > 0 && ids.every(([, id]) => !existentes.has(id)),
      mainUsersValidos: totalMainUsers - faltanMainUsers,
    };
    // No enumerable para que no salga en console.table; lo usa el borrado.
    Object.defineProperty(fila, "usuariosValidos", {
      value: [
        ...new Set(ids.map(([, id]) => id).filter((id) => existentes.has(id))),
      ],
    });
    huerfanos.push(fila);
  }

  // Comprueba Auth (getUsers admite 100 por llamada) y completa el email si falta en BBDD.
  if (auth) {
    for (let i = 0; i < huerfanos.length; i += 100) {
      const lote = huerfanos.slice(i, i + 100);
      const { users } = await auth.getUsers(
        lote.map((h) => ({ uid: h.clientId })),
      );
      const porUid = new Map(users.map((u) => [u.uid, u]));
      for (const h of lote) {
        const usuario = porUid.get(h.clientId);
        h.tieneAuth = Boolean(usuario);
        if (!h.email) h.email = usuario?.email || "";
      }
    }
  }

  console.log(
    `\nClientes revisados: ${Object.keys(clients).length}. Con referencias a usuarios inexistentes: ${huerfanos.length}.`,
  );
  if (huerfanos.length > 0) console.table(huerfanos);
  return huerfanos;
}

/**
 * Revisa los clientes huérfanos uno a uno. Los que no tienen Auth se borran
 * directamente; los que tienen Auth sólo si se confirma con "s".
 * Al borrar se quita también /users/{id}/clients/{clientId} de los usuarios válidos.
 */
async function eliminarClientesHuerfanos(db, auth) {
  if (!auth)
    throw new Error("Se necesita Auth para decidir qué clientes borrar.");
  const huerfanos = await listarClientesHuerfanos(db, auth);
  if (huerfanos.length === 0) return;
  if (!process.stdin.isTTY) {
    throw new Error(
      "Se necesita una terminal interactiva para confirmar borrados.",
    );
  }

  const readline = require("readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const resumen = { borrados: 0, omitidos: 0, errores: 0 };

  try {
    for (const [indice, h] of huerfanos.entries()) {
      const etiqueta = `[${indice + 1}/${huerfanos.length}] ${h.clientId} <${h.email || "sin email"}>`;
      if (h.tieneAuth) {
        const detalle =
          h.usuariosValidos.length > 0
            ? ` (aún vinculado a: ${h.usuariosValidos.join(", ")})`
            : "";
        const respuesta = await rl.question(
          `${etiqueta}${detalle} tiene Auth. ¿Eliminar cliente y su Auth? (s/N): `,
        );
        if (!/^s(i|í)?$/i.test(respuesta.trim())) {
          console.log("   ⏭️  Omitido.");
          resumen.omitidos++;
          continue;
        }
      } else {
        console.log(`${etiqueta} sin Auth: se elimina directamente.`);
      }

      try {
        if (h.tieneAuth) {
          try {
            await auth.deleteUser(h.clientId);
          } catch (error) {
            if (error.code !== "auth/user-not-found") throw error;
          }
        }
        const cambios = { [`clientsData/${h.clientId}`]: null };
        for (const userId of h.usuariosValidos) {
          cambios[`users/${userId}/clients/${h.clientId}`] = null;
        }
        await db.ref().update(cambios);
        console.log("   🗑️  Eliminado.");
        resumen.borrados++;
      } catch (error) {
        console.error(`   ❌ Error al eliminar ${h.clientId}:`, error.message);
        resumen.errores++;
      }
    }
  } finally {
    rl.close();
  }

  console.log(
    `\nResumen: ${resumen.borrados} eliminados, ${resumen.omitidos} omitidos, ${resumen.errores} errores.`,
  );
  if (resumen.errores > 0) process.exitCode = 1;
}

/**
 * Borra exclusivamente en destino. Conserva clientes compartidos y desvincula
 * al usuario de mainUsers. Si existe mainUsers, tiene prioridad sobre mainUserId.
 * Borra projectManagers sólo si coincide mainUserId y todos los equipos listados.
 * El perfil principal se elimina al final para poder reintentar fallos parciales.
 * No es atómico entre Auth y BBDD; ejecutar sin cambios concurrentes de vínculos.
 */
async function eliminarUsuarioDestino(uid) {
  if (
    typeof uid !== "string" ||
    !uid ||
    /[.#$[\]/\u0000-\u001f\u007f]/.test(uid)
  ) {
    throw new Error("El UID del usuario a eliminar no es válido.");
  }

  function validarObjeto(data, ruta) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Se esperaba un objeto en /${ruta}. Borrado cancelado.`);
    }
  }

  function clavesListado(data, ruta) {
    if (data == null) return [];
    validarObjeto(data, ruta);
    return Object.keys(data);
  }

  const userPath = `users/${uid}`;
  const userData = (await targetDb.ref(userPath).once("value")).val();
  validarObjeto(userData, userPath);
  const clientIds = clavesListado(userData.clients, `${userPath}/clients`);
  const managerIds = clavesListado(
    userData.projectManagers,
    `${userPath}/projectManagers`,
  );
  const onnaIds = clavesListado(
    userData.onnaDevices,
    `${userPath}/onnaDevices`,
  );
  const nodosABorrar = [];
  const desvinculaciones = [];
  const authABorrar = new Set([uid]);
  const authAConservar = new Set();

  for (const clientId of clientIds) {
    const clientPath = `clientsData/${clientId}`;
    const clientData = (await targetDb.ref(clientPath).once("value")).val();
    if (clientData == null) {
      console.warn(
        `/${clientPath} no existe; este listado no justifica borrar Auth. Sólo se borrará si otro rol acredita que pertenece al usuario.`,
      );
      continue;
    }
    validarObjeto(clientData, clientPath);

    let borrarCliente = false;
    if (clientData.mainUsers != null) {
      const mainUserIds = clavesListado(
        clientData.mainUsers,
        `${clientPath}/mainUsers`,
      );
      const vinculado = Object.prototype.hasOwnProperty.call(
        clientData.mainUsers,
        uid,
      );
      borrarCliente = vinculado && mainUserIds.length === 1;
      if (vinculado && !borrarCliente) {
        desvinculaciones.push(`${clientPath}/mainUsers/${uid}`);
        if (clientData.mainUserId === uid) {
          desvinculaciones.push(`${clientPath}/mainUserId`);
        }
      }
    } else {
      borrarCliente = clientData.mainUserId === uid;
    }

    if (borrarCliente) {
      nodosABorrar.push(clientPath);
      authABorrar.add(clientId);
    } else {
      authAConservar.add(clientId);
      console.log(`Se conserva /${clientPath} y su Auth por sus vínculos.`);
    }
  }

  for (const managerId of managerIds) {
    const managerPath = `projectManagersData/${managerId}`;
    const managerData = (await targetDb.ref(managerPath).once("value")).val();
    if (managerData == null) {
      console.warn(
        `/${managerPath} no existe; este listado no justifica borrar Auth. Sólo se borrará si otro rol acredita que pertenece al usuario.`,
      );
      continue;
    }
    validarObjeto(managerData, managerPath);
    if (managerData.mainUserId === uid) {
      nodosABorrar.push(managerPath);
      authABorrar.add(managerId);
    } else {
      authAConservar.add(managerId);
      console.log(
        `Se conserva /${managerPath} y su Auth: mainUserId no coincide.`,
      );
    }
  }

  // Una cuenta con algún rol conservado mantiene su Auth; solo se borran los datos del rol propio.
  for (const authUid of authABorrar) {
    if (authAConservar.has(authUid)) {
      authABorrar.delete(authUid);
      console.warn(
        `Se conserva Auth de ${authUid} porque tiene un rol vinculado a otro usuario; solo se borran sus datos propiedad de ${uid}.`,
      );
    }
  }

  console.log(
    `Iniciando borrado en destino del usuario ${uid} y sus datos vinculados.`,
  );
  for (const authUid of authABorrar) {
    try {
      await targetAuth.deleteUser(authUid);
      console.log(`Auth de destino eliminado: ${authUid}.`);
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
      console.warn(`Auth de destino ${authUid} ya no existe; continuando.`);
    }
  }

  for (const linkedPath of desvinculaciones) {
    await targetDb.ref(linkedPath).remove();
    console.log(`Vínculo eliminado en destino: /${linkedPath}.`);
  }
  for (const linkedPath of nodosABorrar) {
    await targetDb.ref(linkedPath).remove();
    console.log(`Datos eliminados en destino: /${linkedPath}.`);
  }
  for (const onnaId of onnaIds) {
    await targetDb.ref(`onna/${onnaId}`).remove();
    console.log(`Equipo eliminado en destino: /onna/${onnaId}.`);
  }
  await targetDb.ref(userPath).remove();
  console.log(
    `✅ Usuario ${uid} y sus datos vinculados eliminados del destino.`,
  );
}

/**
 * Recorre /users y elimina tanto de Auth como de Realtime Database a
 * los usuarios cuyo campo `validated` exista y sea exactamente `false`.
 * Usa la clave del nodo como UID y conserva el nodo si falla Auth,
 * salvo que el usuario ya no exista en Authentication.
 */
async function eliminarUsuariosNoValidados(db, auth) {
  console.log(`\nBuscando usuarios no validados (validated === false)...`);
  try {
    const snapshot = await db.ref("users").once("value");
    const users = snapshot.val();

    if (!users) {
      console.log("No existen usuarios en el path /users.");
      return;
    }

    let eliminadosCount = 0;
    let erroresAuthCount = 0;

    for (const uid in users) {
      const userData = users[uid];

      // Verificamos si la propiedad 'validated' existe explícitamente y es false
      if (
        userData &&
        Object.prototype.hasOwnProperty.call(userData, "validated") &&
        userData.validated === false
      ) {
        console.log(`Eliminando usuario no validado: ${uid}...`);

        // 1. Eliminar de Firebase Authentication
        try {
          await auth.deleteUser(uid);
          console.log(`  - Eliminado de Auth: ${uid}`);
        } catch (authError) {
          if (authError.code === "auth/user-not-found") {
            console.warn(
              `  - El usuario ${uid} no existía en Auth, continuando...`,
            );
          } else {
            console.error(
              `  - Error al eliminar de Auth ${uid}; se conserva /users/${uid}:`,
              authError,
            );
            erroresAuthCount++;
            continue;
          }
        }

        // 2. Eliminar del nodo /users/{uid} en la Realtime Database
        await db.ref(`users/${uid}`).remove();
        console.log(`  - Eliminado de Realtime Database (/users/${uid})`);

        eliminadosCount++;
      }
    }

    if (erroresAuthCount > 0) {
      console.error(
        `❌ Limpieza incompleta. Usuarios eliminados: ${eliminadosCount}. Usuarios conservados por errores de Auth: ${erroresAuthCount}.`,
      );
    } else {
      console.log(
        `✅ Proceso finalizado. Total de usuarios eliminados: ${eliminadosCount}`,
      );
    }
  } catch (error) {
    console.error(`❌ Error al eliminar usuarios no validados:`, error);
  }
}

/**
 * Recorre las notificaciones en /users/{uid}/notifications y elimina
 * aquellas cuya antigüedad de `createdAt` sea superior a los días indicados,
 * en lotes secuenciales (la limpieza completa no es atómica).
 */
async function eliminarNotificacionesAntiguas(db, diasAntiguedad = 30) {
  console.log(
    `\nBuscando notificaciones con más de ${diasAntiguedad} días de antigüedad...`,
  );
  let totalEliminadas = 0;
  try {
    const snapshot = await db.ref("users").once("value");
    const users = snapshot.val();

    if (!users) {
      console.log("No existen usuarios en el path /users.");
      return;
    }

    const ahora = Date.now();
    const msLimite = diasAntiguedad * 24 * 60 * 60 * 1000;
    const maxNotificacionesPorLote = 100;
    const maxBytesPorLote = 1024 * 1024;
    let updates = {};
    let cantidadEnLote = 0;
    let bytesEnLote = 2;

    async function aplicarLote(lote) {
      const entries = Object.entries(lote);
      try {
        await db.ref().update(lote);
      } catch (error) {
        if (error.code !== "WRITE_TOO_BIG" || entries.length === 1) {
          throw error;
        }

        // Firebase también limita el tamaño de los datos afectados por el borrado.
        console.warn(
          `⚠️ Lote de ${entries.length} notificaciones demasiado grande; dividiendo en lotes menores.`,
        );
        const mitad = Math.floor(entries.length / 2);
        await aplicarLote(Object.fromEntries(entries.slice(0, mitad)));
        await aplicarLote(Object.fromEntries(entries.slice(mitad)));
        return;
      }
      totalEliminadas += entries.length;
      console.log(
        `Eliminadas ${entries.length} notificaciones. Total confirmado: ${totalEliminadas}.`,
      );
    }

    for (const uid in users) {
      const notifications = users[uid]?.notifications;

      if (notifications && typeof notifications === "object") {
        for (const notificationId in notifications) {
          const notification = notifications[notificationId];

          if (notification && notification.createdAt) {
            // Convierte createdAt tanto si es un timestamp numérico (ms) como una string de fecha (ISO)
            const fechaCreacion = new Date(notification.createdAt).getTime();

            if (!isNaN(fechaCreacion)) {
              const antiguedadMs = ahora - fechaCreacion;

              if (antiguedadMs > msLimite) {
                const notificationPath = `users/${uid}/notifications/${notificationId}`;
                const bytes =
                  Buffer.byteLength(JSON.stringify(notificationPath), "utf8") +
                  6;
                if (
                  cantidadEnLote > 0 &&
                  (cantidadEnLote >= maxNotificacionesPorLote ||
                    bytesEnLote + bytes > maxBytesPorLote)
                ) {
                  await aplicarLote(updates);
                  updates = {};
                  cantidadEnLote = 0;
                  bytesEnLote = 2;
                }
                updates[notificationPath] = null;
                cantidadEnLote++;
                bytesEnLote += bytes;
              }
            }
          }
        }
      }
    }

    if (cantidadEnLote > 0) {
      await aplicarLote(updates);
    }

    if (totalEliminadas > 0) {
      console.log(
        `✅ Se eliminaron ${totalEliminadas} notificaciones antiguas con éxito.`,
      );
    } else {
      console.log(
        `ℹ️ No se encontraron notificaciones con más de ${diasAntiguedad} días de antigüedad.`,
      );
    }
  } catch (error) {
    console.error(
      `❌ Error al eliminar notificaciones antiguas (${totalEliminadas} eliminadas antes del error):`,
      error,
    );
  }
}

// ==========================================
// EJECUCIÓN
// ==========================================
async function run() {
  // Puedes pasarle 'targetDb' y 'targetAuth' O 'sourceDb' y 'sourceAuth' según dónde quieras ejecutarlo:
  // 1. Limpieza de usuarios no validados
  // await eliminarUsuariosNoValidados(targetDb, sourceAuth);
  // 2. Limpieza de notificaciones antiguas (+30 días) en Prod
  // await eliminarNotificacionesAntiguas(targetDb, 60);
  // 3. Transferencias
  // transferirUsuario copia Auth, perfil, equipos, projectManagers y clients.
  await transferirUsuario("52qEHfUzyrcjdVRHRDwrgAMXc4k2", {
    repararExistente: true,
  });
  // 4. Borrado en destino: Auth, perfil, equipos y vinculados según su propiedad.
  // await eliminarUsuarioDestino("NwpPKoENOKeXl83jI7Fegxw0ZH83");
  // 5. Informe (solo lectura) de clientsData con mainUserId/mainUsers inexistentes.
  // await listarClientesHuerfanos(targetDb, targetAuth);
  // 6. Igual que 5, pero pide confirmación por cliente (sin Auth se borran directamente).
  // await eliminarClientesHuerfanos(targetDb, targetAuth);
}

// Cierra las conexiones persistentes de Firebase sin forzar process.exit().
async function ejecutar() {
  try {
    await run();
  } catch (error) {
    console.error("Error al ejecutar el mantenimiento:", error);
    process.exitCode = 1;
  } finally {
    const apps = [sourceApp, targetApp];
    const resultados = await Promise.allSettled(
      apps.map((app) => deleteApp(app)),
    );
    resultados.forEach((resultado, index) => {
      if (resultado.status === "rejected") {
        console.error(
          `Error al cerrar Firebase (${apps[index].name}):`,
          resultado.reason,
        );
        process.exitCode = 1;
      }
    });
  }
}

ejecutar();
