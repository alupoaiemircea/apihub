const fs = require("fs");
const path = require("path");
const config = require("../../config");
const {CONTAINERS} = require("./constants");


function SecretsService(serverRootFolder) {
    serverRootFolder = serverRootFolder || config.getConfig("storage");
    const DEFAULT_CONTAINER_NAME = "default";
    const API_KEY_CONTAINER_NAME = "apiKeys";
    const getStorageFolderPath = () => {
        return path.join(serverRootFolder, config.getConfig("externalStorage"), "secrets");
    }

    const lockPath = path.join(getStorageFolderPath(), "secret.lock");
    const lock = require("../../utils/ExpiringFileLock").getLock(lockPath, 10000);
    console.log("Secrets Service initialized");
    const logger = $$.getLogger("secrets", "apihub/secrets");
    const openDSU = require("opendsu");
    const crypto = openDSU.loadAPI("crypto");
    const encryptionKeys = process.env.SSO_SECRETS_ENCRYPTION_KEY ? process.env.SSO_SECRETS_ENCRYPTION_KEY.split(",") : undefined;
    let latestEncryptionKey = encryptionKeys ? encryptionKeys[0].trim() : undefined;
    let successfulEncryptionKeyIndex = 0;
    const containers = {};
    let readonlyMode = false;

    const apiKeyExists = (apiKeysContainer, apiKey) => {
        const apiKeys = Object.values(apiKeysContainer);
        if (apiKeys.length === 0) {
            return false;
        }
        let index = apiKeys.findIndex(el => el === apiKey);
        return index !== -1;
    }

    const loadContainerAsync = async (containerName) => {
        try {
            containers[containerName] = await getDecryptedSecretsAsync(containerName);
            console.info("Secrets container", containerName, "loaded");
        } catch (e) {
            containers[containerName] = {};
            console.info("Initializing secrets container", containerName);
        }

        if (containerName === API_KEY_CONTAINER_NAME) {
            const apiKey = require("opendsu").loadAPI("crypto").sha256JOSE(process.env.SSO_SECRETS_ENCRYPTION_KEY, "base64");
            if (!apiKeyExists(containers[containerName], apiKey)) {
                console.log("API Key not found in container", containerName);
                containers[containerName][apiKey] = apiKey;
                await writeSecretsAsync(containerName);
            }
        }
    }

    this.loadContainersAsync = async () => {
        ensureFolderExists(getStorageFolderPath());
        let secretsContainersNames = fs.readdirSync(getStorageFolderPath());
        if (secretsContainersNames.length) {
            secretsContainersNames = secretsContainersNames.map((containerName) => {
                const extIndex = containerName.lastIndexOf(".");
                return path.basename(containerName).substring(0, extIndex);
            })

            for (let containerName of secretsContainersNames) {
                await loadContainerAsync(containerName);
            }
        } else {
            logger.info("No secrets containers found");
        }
    }

    this.forceWriteSecretsAsync = async () => {
        ensureFolderExists(getStorageFolderPath());
        let secretsContainersNames = fs.readdirSync(getStorageFolderPath());
        if (secretsContainersNames.length) {
            secretsContainersNames = secretsContainersNames.map((containerName) => {
                const extIndex = containerName.lastIndexOf(".");
                return path.basename(containerName).substring(0, extIndex);
            })

            for (let containerName of secretsContainersNames) {
                await writeSecretsAsync(containerName);
            }
        } else {
            logger.info("No secrets containers found");
        }
    }
    const createError = (code, message) => {
        const err = Error(message);
        err.code = code

        return err;
    }

    const encryptSecret = (secret) => {
        const encryptionKeys = process.env.SSO_SECRETS_ENCRYPTION_KEY ? process.env.SSO_SECRETS_ENCRYPTION_KEY.split(",") : undefined;
        if (!encryptionKeys) {
            throw Error("process.env.SSO_SECRETS_ENCRYPTION_KEY is empty")
        }
        let latestEncryptionKey = encryptionKeys[0];
        if (!$$.Buffer.isBuffer(latestEncryptionKey)) {
            latestEncryptionKey = $$.Buffer.from(latestEncryptionKey, "base64");
        }

        return crypto.encrypt(secret, latestEncryptionKey);
    }

    const writeSecrets = (secretsContainerName, callback) => {
        if (readonlyMode) {
            return callback(createError(555, `Secrets Service is in readonly mode`));
        }
        let secrets = containers[secretsContainerName];
        secrets = JSON.stringify(secrets);
        const encryptedSecrets = encryptSecret(secrets);
        fs.writeFile(getSecretFilePath(secretsContainerName), encryptedSecrets, callback);
    }

    const writeSecretsAsync = async (secretsContainerName) => {
        return await $$.promisify(writeSecrets)(secretsContainerName);
    }
    const ensureFolderExists = (folderPath) => {
        try {
            fs.accessSync(folderPath);
        } catch (e) {
            fs.mkdirSync(folderPath, {recursive: true});
        }
    }


    const getSecretFilePath = (secretsContainerName) => {
        const folderPath = getStorageFolderPath(secretsContainerName);
        return path.join(folderPath, `${secretsContainerName}.secret`);
    }

    const decryptSecret = async (secretsContainerName, encryptedSecret) => {
        let bufferEncryptionKey = latestEncryptionKey;
        if (!$$.Buffer.isBuffer(bufferEncryptionKey)) {
            bufferEncryptionKey = $$.Buffer.from(bufferEncryptionKey, "base64");
        }

        return crypto.decrypt(encryptedSecret, bufferEncryptionKey);
    };

    const getDecryptedSecrets = (secretsContainerName, callback) => {
        const filePath = getSecretFilePath(secretsContainerName);
        fs.readFile(filePath, async (err, secrets) => {
            if (err || !secrets) {
                logger.error(`Failed to read file ${filePath}`);
                return callback(createError(404, `Failed to read file ${filePath}`));
            }

            let decryptedSecrets;
            try {
                decryptedSecrets = await decryptSecret(secretsContainerName, secrets);
            } catch (e) {
                logger.error(`Failed to decrypt secrets`);
                readonlyMode = true;
                console.log("Readonly mode activated")
                return callback(createError(555, `Failed to decrypt secrets`));
            }

            try {
                decryptedSecrets = JSON.parse(decryptedSecrets.toString());
            } catch (e) {
                logger.error(`Failed to parse secrets`);
                return callback(createError(555, `Failed to parse secrets`));
            }

            callback(undefined, decryptedSecrets);
        });
    }

    const getDecryptedSecretsAsync = async (secretsContainerName) => {
        return await $$.promisify(getDecryptedSecrets, this)(secretsContainerName);
    }

    this.putSecretAsync = async (secretsContainerName, secretName, secret, isAdmin) => {
        await lock.lock();
        let res;
        try {
            await loadContainerAsync(secretsContainerName);
            if (!containers[secretsContainerName]) {
                containers[secretsContainerName] = {};
                console.info("Initializing secrets container", secretsContainerName)
            }
            if (typeof isAdmin !== "undefined") {
                containers[secretsContainerName][secretName] = {};
                containers[secretsContainerName][secretName].secret = secret;
                containers[secretsContainerName][secretName].isAdmin = isAdmin;
            } else {
                containers[secretsContainerName][secretName] = secret;
            }
            res = await writeSecretsAsync(secretsContainerName, secretName);
        } catch (e) {
            await lock.unlock();
            throw e;
        }
        await lock.unlock();
        return res;
    }

    this.putSecretInDefaultContainerAsync = async (secretName, secret) => {
        return await this.putSecretAsync(DEFAULT_CONTAINER_NAME, secretName, secret);
    }

    this.getSecretSync = (secretsContainerName, secretName) => {
        if (readonlyMode) {
            throw createError(555, `Secrets Service is in readonly mode`);
        }
        if (!containers[secretsContainerName]) {
            containers[secretsContainerName] = {};
            console.info("Initializing secrets container", secretsContainerName);
        }
        const secret = containers[secretsContainerName][secretName];
        if (!secret) {
            throw createError(404, `Secret for user ${secretName} not found`);
        }

        return secret;
    }

    this.readSecretSync = this.getSecretSync;

    this.getSecretFromDefaultContainerSync = (secretName) => {
        return this.getSecretSync(DEFAULT_CONTAINER_NAME, secretName);
    }

    this.readSecretFromDefaultContainerSync = this.getSecretFromDefaultContainerSync;

    this.generateAPIKeyAsync = async (keyId, isAdmin) => {
        const apiKey = crypto.generateRandom(32).toString("base64");
        await this.putSecretAsync(API_KEY_CONTAINER_NAME, keyId, apiKey, isAdmin);
        return apiKey;
    }

    this.deleteAPIKeyAsync = async (keyId) => {
        await this.deleteSecretAsync(API_KEY_CONTAINER_NAME, keyId);
    }

    this.apiKeysContainerIsEmpty = () => {
        return Object.keys(containers[API_KEY_CONTAINER_NAME] || {}).length === 0;
    }

    this.validateAPIKey = async (apiKey) => {
        await loadContainerAsync(CONTAINERS.API_KEY_CONTAINER_NAME);
        const container = containers[API_KEY_CONTAINER_NAME];
        if (!container) {
            return false;
        }

        return apiKeyExists(container, apiKey);
    }

    this.isAdminAPIKey = (apiKey) => {
        const container = containers[API_KEY_CONTAINER_NAME];
        if (!container) {
            return false;
        }
        const apiKeyObjs = Object.values(container);
        if (apiKeyObjs.length === 0) {
            return false;
        }
        let index = apiKeyObjs.findIndex((obj) => {
            return obj.secret === apiKey && obj.isAdmin;
        });
        return index !== -1;
    }

    this.getAllSecretsSync = (secretsContainerName) => {
        if (readonlyMode) {
            throw createError(555, `Secrets Service is in readonly mode`);
        }
        if (!containers[secretsContainerName]) {
            containers[secretsContainerName] = {};
            console.info("Initializing secrets container", secretsContainerName);
        }
        return containers[secretsContainerName];
    }

    this.generateServerSecretAsync = async (secretName) => {
        const secret = crypto.generateRandom(32).toString("base64");
        return await this.putSecretInDefaultContainerAsync(secretName, secret);
    }

    this.deleteSecretAsync = async (secretsContainerName, secretName) => {
        await lock.lock();
        try {
            await loadContainerAsync(secretsContainerName);
            if (!containers[secretsContainerName]) {
                containers[secretsContainerName] = {};
                console.info("Initializing secrets container", secretsContainerName)
            }
            if (!containers[secretsContainerName][secretName]) {
                throw createError(404, `Secret for user ${secretName} not found`);
            }
            delete containers[secretsContainerName][secretName];
            await writeSecretsAsync(secretsContainerName);
        } catch (e) {
            await lock.unlock();
            throw e;
        }
        await lock.unlock();
    }

    this.rotateKeyAsync = async () => {
        let writeKey = encryptionKeys[0].trim();
        let readKey = encryptionKeys.length === 2 ? encryptionKeys[1].trim() : writeKey;

        if (readonlyMode) {
            if (encryptionKeys.length !== 2) {
                logger.info(0x501, `Rotation not possible`);
                return;
            }
            logger.info(0x501, "Secrets Encryption Key rotation detected");
            readonlyMode = false;
            latestEncryptionKey = readKey;
            await this.loadContainersAsync();
            if (readonlyMode) {
                logger.info(0x501, `Rotation not possible because wrong decryption key was provided. The old key should be the second one in the list`);
                return;
            }
            latestEncryptionKey = writeKey;
            await this.forceWriteSecretsAsync();
            logger.info(0x501, `Re-encrypting Recovery Passphrases on disk completed`)
        }
    }
}

let secretsServiceInstance;
const getSecretsServiceInstanceAsync = async (serverRootFolder) => {
    if (!secretsServiceInstance) {
        secretsServiceInstance = new SecretsService(serverRootFolder);
        await secretsServiceInstance.loadContainersAsync();
    }
    return secretsServiceInstance;
}

module.exports = {
    getSecretsServiceInstanceAsync
};
