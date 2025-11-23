// 필요한 모듈 불러오기
const express = require('express');
const admin = require('firebase-admin');
const cron = require('node-cron');

// 로컬 JSON 데이터 불러오기
let gasDataJson = [];
try {
    gasDataJson = require('./csv/gas_data.json');
} catch(e) {
    console.warn("경고: ./csv/gas_data.json 파일을 찾을 수 없습니다.");
}

const app = express();
app.use(express.json()); // JSON 요청 본문을 파싱하기 위해 추가

// Render 환경 변수에서 키 정보 불러오기
let serviceAccountKey;
try {
  serviceAccountKey = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error("SERVICE_ACCOUNT_KEY 환경 변수가 올바른 JSON 형식이 아닙니다. Render 대시보드에서 키 값을 다시 확인해주세요.", e);
  process.exit(1);
}

try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccountKey),
      databaseURL: "https://capstone-55527-default-rtdb.asia-southeast1.firebasedatabase.app",
      storageBucket: "capstone-55527.firebasestorage.app" 
    });
} catch(error) {
    console.error("Firebase 초기화 실패:", error);
}

const PORT = process.env.PORT || 3000;
const db = admin.database();

// --- 데이터 업데이트 관련 함수 ---

async function accumulateOrPushData(dataToSave) {
  const { electricityValue, gasValue } = dataToSave;
  const ref = db.ref('sensor_data');
  
  try {
    const snapshot = await ref.orderByKey().limitToLast(1).once('value');
    let latestKey = null;

    if (snapshot.exists()) {
      latestKey = Object.keys(snapshot.val())[0];
    }

    if (latestKey) {
      const latestRecordRef = ref.child(latestKey);
      await latestRecordRef.transaction((currentData) => {
        if (currentData === null) return null;
        
        const newTimestamp = admin.database.ServerValue.TIMESTAMP;
        if (!isNaN(electricityValue)) {
          currentData.electricity = currentData.electricity || { value: 0 };
          currentData.electricity.value = (currentData.electricity.value || 0) + electricityValue;
          currentData.electricity.timestamp = newTimestamp;
        }
        if (!isNaN(gasValue)) {
          currentData.gas = currentData.gas || { value: 0 };
          currentData.gas.value = (currentData.gas.value || 0) + gasValue;
          currentData.gas.timestamp = newTimestamp;
        }
        return currentData;
      });
      console.log(`[데이터 누적] (Key: ${latestKey})`, dataToSave);
      return { accumulated: true, key: latestKey };

    } else {
      const newData = {};
      const timestamp = admin.database.ServerValue.TIMESTAMP;
      if (!isNaN(electricityValue)) newData.electricity = { value: electricityValue, timestamp: timestamp };
      if (!isNaN(gasValue)) newData.gas = { value: gasValue, timestamp: timestamp };

      if (Object.keys(newData).length > 0) {
        const newRecordRef = await ref.push(newData);
        console.log(`[새 데이터]`, newData);
        return { accumulated: false, key: newRecordRef.key };
      }
      return { accumulated: false, key: null };
    }
  } catch (error) {
    console.error('데이터 저장 오류:', error);
    throw error;
  }
}

async function updateSingleData() {
  try {
    const powerData = Math.floor(Math.random() * (450 - 250 + 1)) + 250;
    const latestGasData = (gasDataJson.length > 0) ? gasDataJson[gasDataJson.length - 1].average : 0;
    await accumulateOrPushData({ electricityValue: powerData, gasValue: latestGasData });
    return true;
  } catch (error) {
    console.error('스케줄링 업데이트 오류:', error);
    return false;
  }
}

cron.schedule('0 0 * * *', async () => {
  console.log('스케줄러 시작');
  await updateSingleData();
});

// --- API 엔드포인트 ---

app.post('/api/sensor-data', async (req, res) => {
  const { electricity, gas } = req.body;
  const electricityValue = parseFloat(electricity);
  const gasValue = parseFloat(gas);

  if (isNaN(electricityValue) && isNaN(gasValue)) {
    return res.status(400).json({ error: '유효한 값이 없습니다.' });
  }

  try {
    const result = await accumulateOrPushData({ electricityValue, gasValue });
    res.status(result.accumulated ? 200 : 201).json({ message: '처리 완료', key: result.key });
  } catch (error) {
    res.status(500).json({ error: '서버 오류' });
  }
});

app.get('/api/usage-data', async (req, res) => {
  try {
    const snapshot = await db.ref('sensor_data').orderByChild('electricity/timestamp').once('value');
    const data = snapshot.val();
    if (!data) return res.status(200).json({ electricity: [], gas: [] });

    const electricityData = [];
    const gasData = [];
    Object.keys(data).forEach(key => {
      const entry = data[key];
      if (entry.electricity) electricityData.push(entry.electricity);
      if (entry.gas) gasData.push(entry.gas);
    });
    res.status(200).json({ electricity: electricityData, gas: gasData });
  } catch (error) {
    res.status(500).json({ error: '서버 오류' });
  }
});

app.get('/api/force-update', async (req, res) => {
  const success = await updateSingleData();
  res.status(success ? 200 : 500).send(success ? '성공' : '실패');
});

app.get('/api/init-historical-data', async (req, res) => {
    try {
        if (!gasDataJson || gasDataJson.length === 0) return res.status(400).send('json 파일 없음');
        const ref = db.ref('sensor_data');
        await ref.set(null);
        for (const item of gasDataJson) {
            const timestamp = new Date(item.month + '-01').getTime();
            await ref.push({
                electricity: { value: Math.floor(Math.random() * 200) + 250, timestamp },
                gas: { value: item.average, timestamp }
            });
        }
        res.status(200).send('초기화 성공');
    } catch(error) {
        res.status(500).send('오류 발생');
    }
});

// --- 사용자 관리 API (수정된 부분) ---

const usersRef = db.ref('users');

app.get('/api/users', async (req, res) => {
    try {
        const snapshot = await usersRef.once('value');
        res.status(200).json(snapshot.val() || {});
    } catch (error) {
        res.status(500).json({ error: '서버 오류' });
    }
});

/**
 * [수정 완료] 사용자 추가 (회원가입 + 단순 친구 추가 통합)
 */
app.post('/api/users', async (req, res) => {
    try {
        // 1. 회원가입 요청인지 확인 (ID와 Password가 있는 경우)
        if (req.body.id && req.body.password) {
            const { id, username, password } = req.body;
            
            // 중복 확인
            const idSnapshot = await usersRef.orderByChild('id').equalTo(id).once('value');
            if (idSnapshot.exists()) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
            
            const usernameSnapshot = await usersRef.orderByChild('username').equalTo(username).once('value');
            if (usernameSnapshot.exists()) return res.status(409).json({ error: '이미 사용 중인 이름입니다.' });

            const newUserRef = usersRef.push();
            await newUserRef.set({ id, username, password });
            return res.status(201).json({ id: newUserRef.key, message: '회원가입 성공' });
        } 
        
        // 2. 단순 사용자(친구/가족) 추가 요청인 경우 (Name만 있는 경우)
        else if (req.body.name) {
            const newUserRef = usersRef.push();
            // 요청받은 데이터(이름, 역할, 이미지 등)를 그대로 저장
            await newUserRef.set(req.body);
            console.log("단순 사용자 추가됨:", req.body.name);
            return res.status(201).json({ id: newUserRef.key, message: '사용자 추가 성공' });
        }

        // 3. 필수 정보 누락
        else {
            return res.status(400).json({ error: '필수 정보(id/pw 또는 name)가 없습니다.' });
        }

    } catch (error) {
        console.error('사용자 추가 오류:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

app.put('/api/users/:id', async (req, res) => {
    try {
        await usersRef.child(req.params.id).update(req.body);
        res.status(200).send('수정 성공');
    } catch (error) {
        res.status(500).json({ error: '오류' });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    const userId = req.params.id;
    const userRef = usersRef.child(userId);
    try {
        const snapshot = await userRef.once('value');
        const userData = snapshot.val();
        if (userData && userData.imageUrl) {
            try {
                const filePath = decodeURIComponent(userData.imageUrl.split('/o/')[1].split('?')[0]);
                await admin.storage().bucket().file(filePath).delete();
            } catch(e) { console.warn('이미지 삭제 실패(무시):', e.message); }
        }
        await userRef.remove();
        res.status(200).send('삭제 성공');
    } catch (error) {
        res.status(500).json({ error: '오류' });
    }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
