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

/**
 * [추가] 두 경로의 데이터를 가져와 병합하고 시간순으로 정렬하는 함수
 * @param {string} path1 첫 번째 경로 ('sensor_data')
 * @param {string} path2 두 번째 경로 ('test')
 * @returns {Promise<{electricity: Array, gas: Array}>} 병합된 데이터
 */
async function fetchAndMergeUsageData(path1, path2) {
    const ref1 = db.ref(path1);
    const ref2 = db.ref(path2);

    // 두 경로에서 동시에 데이터를 가져옵니다.
    const [snapshot1, snapshot2] = await Promise.all([
        ref1.once('value'),
        ref2.once('value').catch(e => {
            // test 경로가 없거나 오류가 나도 무시하고 빈 값으로 처리
            console.warn(`경고: ${path2} 경로 조회 중 오류 발생 (무시) - ${e.message}`);
            return null;
        })
    ]);

    const data1 = snapshot1.val() || {};
    const data2 = (snapshot2 && snapshot2.val()) ? snapshot2.val() : {};

    const allData = { ...data1, ...data2 }; // 키가 중복되지 않는다고 가정하고 병합

    const electricityData = [];
    const gasData = [];

    // 모든 데이터를 순회하며 electricity 및 gas 값을 추출
    Object.keys(allData).forEach(key => {
        const entry = allData[key];
        // sensor_data 구조: { electricity: { value, timestamp }, gas: { value, timestamp } }
        if (entry.electricity && entry.electricity.timestamp) {
            electricityData.push(entry.electricity);
        }
        if (entry.gas && entry.gas.timestamp) {
            gasData.push(entry.gas);
        }
        
        // test 경로에서 들어온 데이터 구조를 처리합니다.
        // test 경로 데이터가 sensor_data와 동일한 구조라고 가정 (예: ESP32에서 push)
        if (entry.electric_value && entry.timestamp) {
             // test 경로는 단순 값을 가지고 있을 수도 있어, electricity와 gas의 value/timestamp를 직접 확인합니다.
            
             // 사용자가 "test"에 측정값이 들어간다고 했으므로, test 경로의 데이터 구조를 예상하여 처리합니다.
             // 만약 test 경로의 데이터가 { "value": X, "timestamp": Y } 형태라면 아래와 같이 처리해야 합니다.
             // 현재 UsageActivity는 { "value": X, "timestamp": Y } 형태의 배열을 기대합니다.
             
             // 만약 test 경로의 데이터가 { "electric_value": X, "gas_value": Y, "timestamp": Z } 라면:
             electricityData.push({ value: entry.electric_value, timestamp: entry.timestamp });
             gasData.push({ value: entry.gas_value, timestamp: entry.timestamp });
        }
        
        // *참고: ESP32에서 test 경로에 저장하는 정확한 데이터 구조를 알 수 없어,
        // 최대한 유연하게 처리하기 위해 value와 timestamp를 포함하는 객체로 추출합니다.
        // 만약 test 경로의 데이터가 { "value": X, "timestamp": Y } 형태라면 위 `entry.electricity`와 `entry.gas` 추출 로직으로 커버됩니다.
    });

    // timestamp 기준으로 정렬
    electricityData.sort((a, b) => a.timestamp - b.timestamp);
    gasData.sort((a, b) => a.timestamp - b.timestamp);

    return { electricity: electricityData, gas: gasData };
}

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

// [수정] sensor_data와 test 경로 데이터를 병합하여 반환하도록 변경
app.get('/api/usage-data', async (req, res) => {
  try {
    const mergedData = await fetchAndMergeUsageData('sensor_data', 'test');
    res.status(200).json(mergedData);
  } catch (error) {
    console.error('Usage data fetch error:', error);
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

/**
 * [수정 완료] 사용자 조회 (GET /api/users)
 * - ownerId 쿼리 파라미터가 있으면 해당 주인의 데이터만 필터링해서 반환
 */
app.get('/api/users', async (req, res) => {
    try {
        const ownerId = req.query.ownerId; // 요청에서 ownerId 확인
        const snapshot = await usersRef.once('value');
        const allUsers = snapshot.val() || {};

        if (ownerId) {
            // ownerId가 있으면 필터링 수행
            const filteredUsers = {};
            for (const [key, user] of Object.entries(allUsers)) {
                // 1. 내가 만든 유저 (user.ownerId == ownerId)
                // 2. 또는 나 자신 (user.id == ownerId) -> 이건 선택사항이나 포함해둠
                if (user.ownerId === ownerId || user.id === ownerId) {
                    filteredUsers[key] = user;
                }
            }
            res.status(200).json(filteredUsers);
        } else {
            // ownerId가 없으면 전체 반환 (기존 호환성 유지)
            res.status(200).json(allUsers);
        }
    } catch (error) {
        console.error('사용자 조회 오류:', error);
        res.status(500).json({ error: '서버 오류' });
    }
});

app.post('/api/users', async (req, res) => {
    try {
        // 1. 회원가입 (ID/PW 있음)
        if (req.body.id && req.body.password) {
            const { id, username, password } = req.body;
            const idSnapshot = await usersRef.orderByChild('id').equalTo(id).once('value');
            if (idSnapshot.exists()) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
            
            const usernameSnapshot = await usersRef.orderByChild('username').equalTo(username).once('value');
            if (usernameSnapshot.exists()) return res.status(409).json({ error: '이미 사용 중인 이름입니다.' });

            const newUserRef = usersRef.push();
            await newUserRef.set({ id, username, password });
            return res.status(201).json({ id: newUserRef.key, message: '회원가입 성공' });
        } 
        
        // 2. 단순 사용자 추가 (이름만 있음)
        else if (req.body.name) {
            const newUserRef = usersRef.push();
            // ownerId가 포함된 body를 그대로 저장
            await newUserRef.set(req.body); 
            console.log("단순 사용자 추가됨:", req.body.name, "Owner:", req.body.ownerId);
            return res.status(201).json({ id: newUserRef.key, message: '사용자 추가 성공' });
        }

        else {
            return res.status(400).json({ error: '필수 정보가 없습니다.' });
        }

    } catch (error) {
        console.error('사용자 추가 오류:', error);
        res.status(500).json({ error: '서버 오류' });
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
