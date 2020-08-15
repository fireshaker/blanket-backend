import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import axios from 'axios';

admin.initializeApp();

async function pingUrl(url: string) {
  axios.interceptors.request.use(config => {
    (config as any).metadata = { startTime: new Date().getTime() };
    return config;
  }, Promise.reject);

  axios.interceptors.response.use(response => {
    (response.config as any).metadata.endTime = new Date().getTime();
    (response as any).duration = (response.config as any).metadata.endTime - (response.config as any).metadata.startTime;
    return response;
  }, error => {
    error.config.metadata.endTime = new Date().getTime();
    error.duration = error.config.metadata.endTime - error.config.metadata.startTime;
    return Promise.reject(error);
  });

  try {
    const response = await axios.post(url, { warmUp: true });
    return (response as any).duration as number;
  } catch (error) {
    // Most requests will probably fail since we don't provide any arguments.
    // We just want to know how long it took to get any response.
    return error.duration as number;
  }
}

// TODO: Having a timeout of 540s might still not be enough since we are pinging serverless functions that might have long cold starts.
export const pingFunctions = functions.runWith({ timeoutSeconds: 540, memory: '1GB' }).pubsub.schedule('every 15 minutes').onRun(async () => {
  const monitoredFunctions = await admin.firestore().collection('monitoredFunctions').get();

  await Promise.all(monitoredFunctions.docs.map(async doc => {
    const data = doc.data();
    if (data.enabled && data.functionUrl) {
      const duration = await pingUrl(data.functionUrl);
      await doc.ref.collection('pings').add({
        timestamp: new Date().getTime(),
        responseDuration: duration,
      });
    }
  }));
});

interface FunctionInfo {
  functionName: string;
  functionUrl?: string;
  projectId: string;
  tag: string | null;
  region: string;
  enabled: boolean;
}

export const monitoredFunction = functions.runWith({ memory: '1GB' }).https.onRequest(async (req, res) => {
  try {
    const info = req.body as FunctionInfo;
    const result = await admin.firestore().collection('monitoredFunctions')
      .where('functionName', '==', info.functionName)
      .where('projectId', '==', info.projectId)
      .where('region', '==', info.region)
      .where('tag', '==', info.tag)
      .get();

    if (result.empty) {
      try {
        const doc = await admin.firestore().collection('monitoredFunctions').add(info);
        res.json({
          monitoringIds: [doc.id],
        });
        return;
      } catch (error) {
        console.error(error);
        res.status(500).json({
          message: 'Cannot add new monitored function to the Firestore',
          error,
        });
        return;
      }
    }

    try {
      const monitoringIds = await Promise.all(result.docs.map(async (doc) => {
        const data = doc.data();
        if (info.enabled && data.enabled) {
          return;
        }
        if (!info.enabled && !data.enabled) {
          return;
        }
        if (info.enabled && !data.enabled) {
          await doc.ref.set(info, { merge: true });
          return doc.id;
        }
        if (!info.enabled && data.enabled) {
          await doc.ref.set(info, { merge: true });
          return doc.id;
        }
        return;
      }));
      res.json({
        monitoringIds: monitoringIds.filter((id) => !!id),
      });
      return;
    } catch (error) {
      res.status(500).json({
        message: 'Cannot update monitored functions in the Firestore',
        error,
      });
      return;
    }
  } catch (error) {
    res.status(500).json({
      message: 'Cannot find monitored function - Invalid parameters',
      error,
    });
    return;
  }
});


export const monitoringData = functions.runWith({ memory: '1GB' }).https.onRequest(async (req, res) => {
  try {
    const info = req.body as FunctionInfo;
    const result = await (Object.keys(info) as (keyof Partial<FunctionInfo>)[])
      .reduce<FirebaseFirestore.Query<FirebaseFirestore.DocumentData>>((query, key) => {
        const value = info[key];
        if (value !== undefined) {
          return query.where(key, '==', value);
        }
        return query;
      }, admin.firestore().collection('monitoredFunctions'))
      .get();

    // .where('functionName', '==', info.functionName)
    //   .where('projectId', '==', info.projectId)
    //   .where('region', '==', info.region)
    //   .where('tag', '==', info.tag)
    //   .get();

    if (result.empty) {
      res.json({
        data: [],
      });
      return;
    }

    try {
      const data = await Promise.all(result.docs.map(async (fn) => {
        const pings = await fn.ref.collection('pings').get();
        return {
          fn: fn.data(),
          pings: pings.empty ? [] : pings.docs.map((ping) => ping.data()).sort((ping1, ping2) => ping1.timestamp - ping2.timestamp),
        }
      }));
      res.json({
        data
      });
      return;
    } catch (error) {
      res.status(500).json({
        message: 'Cannot retrieve function pings from the Firestore',
        error,
      });
      return;
    }
  } catch (error) {
    res.status(500).json({
      message: 'Cannot find monitored function - Invalid parameters',
      error,
    });
    return;
  }
});


