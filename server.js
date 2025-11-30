// 필요한 모듈 불러오기
const express = require('express');
const admin = require('firebase-admin');
const cron = require('node-cron');
const axios = require('axios'); // [추가] 외부 딥러닝 서버 호출을 위해 axios 모듈 사용 가정

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

// [추가] Firebase 참조
const usersRef = db.ref('users');
const controlsRef = db.ref('controls');
const logsRef = db.ref('logs/access');
const latestCaptureRef = db.ref('latest_capture');

// [설정] 딥러닝 서버 URL (실제 URL로 대체해야 함)
const DEEP_LEARNING_SERVER_URL = "http://deep-learning-auth-server.com/verify";


// --- 데이터 업데이트 관련 함수 (기존 로직 유지) ---
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
 * sensor_data와 test 경로 데이터를 가져와 병합하고 시간순으로 정렬하는 함수 (기존 로직 유지)
 */
async function fetchAndMergeUsageData(path1, path2) {
    const ref1 = db.ref(path1);
    const ref2 = db.ref(path2);

    const [snapshot1, snapshot2] = await Promise.all([
        ref1.once('value'),
        ref2.once('value').catch(e => {
            console.warn(`경고: ${path2} 경로 조회 중 오류 발생 (무시) - ${e.message}`);
            return null;
        })
    ]);

    const data1 = snapshot1.val() || {};
    const data2 = (snapshot2 && snapshot2.val()) ? snapshot2.val() : {};

    const allData = { ...data1, ...data2 }; 

    const electricityData = [];
    const gasData = [];

    // 모든 데이터를 순회하며 다양한 구조 포괄적으로 추출
    Object.keys(allData).forEach(key => {
        const entry = allData[key];
        
        // 1. sensor_data 구조: { electricity: { value, timestamp }, gas: { value, timestamp } }
        if (entry.electricity && entry.electricity.value !== undefined && entry.electricity.timestamp) {
            electricityData.push({ value: entry.electricity.value, timestamp: entry.electricity.timestamp });
        }
        if (entry.gas && entry.gas.value !== undefined && entry.gas.timestamp) {
            gasData.push({ value: entry.gas.value, timestamp: entry.gas.timestamp });
        }
        
        // 2. test 경로에서 들어올 수 있는 구조 (예: { electric_value: X, gas_value: Y, timestamp: Z })
        if (entry.electric_value !== undefined && entry.timestamp) {
             electricityData.push({ value: entry.electric_value, timestamp: entry.timestamp });
        }
        if (entry.gas_value !== undefined && entry.timestamp) {
             gasData.push({ value: entry.gas_value, timestamp: entry.timestamp });
        }
    });

    // timestamp 기준으로 정렬
    electricityData.sort((a, b) => a.timestamp - b.timestamp);
    gasData.sort((a, b) => a.timestamp - b.timestamp);

    return { electricity: electricityData, gas: gasData };
}

/**
 * 값이 유효한 숫자인지 확인하고 변환하는 헬퍼 함수 (기존 로직 유지)
 */
function getValidNumber(value) {
    if (value === null || value === undefined) return 0.0;
    const num = parseFloat(value);
    return isFinite(num) ? num : 0.0;
}

/**
 * realtime_env에서 필요한 데이터를 가져옵니다. (기존 로직 유지)
 */
async function fetchRealtimeEnvData() {
    const realtimeRef = db.ref('realtime_env');
    const snapshot = await realtimeRef.once('value');
    const data = snapshot.val() || {};
    
    return {
        realtime_temp: getValidNumber(data.temp),
        realtime_humidity: getValidNumber(data.humidity),
        realtime_gas: getValidNumber(data.gas),
        realtime_power_W: getValidNumber(data.power_W) // power_W 포함
    };
}


// -------------------- API 엔드포인트 --------------------

// 센서 데이터 포스트 (기존 로직 유지)
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

/**
 * usage-data 반환 (기존 로직 유지)
 */
app.get('/api/usage-data', async (req, res) => {
  try {
    const mergedData = await fetchAndMergeUsageData('sensor_data', 'test');
    const realtimeData = await fetchRealtimeEnvData();
    
    const responseData = {
        ...mergedData,
        ...realtimeData 
    };
    
    res.status(200).json(responseData);
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
        res.status(500).json({ error: '오류 발생' });
    }
});


// -------------------- [추가] 인증 및 딥러닝 연동 API --------------------

/**
 * POST /api/authenticate
 * App에서 인증 요청을 받으면, 캡처 데이터와 사용자 정보를 딥러닝 서버로 전달하고,
 * 결과를 받아 door_state와 로그를 업데이트합니다.
 */
app.post('/api/authenticate', async (req, res) => {
    const { username } = req.body;

    if (!username) {
        return res.status(400).json({ error: '인증할 사용자 이름이 필요합니다.' });
    }

    try {
        // 1. 최신 캡처 데이터 (이미지 URL, 음성 레벨) 가져오기
        const captureSnapshot = await latestCaptureRef.once('value');
        const captureData = captureSnapshot.val();

        if (!captureData || !captureData.imageUrl || !captureData.dB_level) {
            // 데이터가 없으면 DB에 거절 상태 기록
            await controlsRef.child('door_state').set('refusal');
            console.warn('인증 실패: 최신 캡처 데이터 불완전.');
            return res.status(404).json({ error: '최신 캡처 데이터가 불완전합니다. ESP32-CAM 확인 필요.' });
        }
        
        // 2. 등록된 사용자 정보 가져오기 (비교 기준 데이터)
        const userSnapshot = await usersRef.orderByChild('username').equalTo(username).once('value');
        const userDataKey = userSnapshot.exists() ? Object.keys(userSnapshot.val())[0] : null;
        const userData = userDataKey ? userSnapshot.val()[userDataKey] : null;

        if (!userData || !userData.registered_image_url || !userData.registered_voice_level) {
            // 미등록 사용자 또는 등록 데이터 불완전
            const logEntry = {
                timestamp: new Date().toISOString(),
                result: 'refusal',
                type: 'FACE_VOICE',
                username: username,
                logMessage: '미등록 사용자 또는 등록 데이터 불완전',
                imageUrl: captureData.imageUrl,
                dB_level: captureData.dB_level,
                timeMillis: admin.database.ServerValue.TIMESTAMP
            };
            await controlsRef.child('door_state').set('refusal');
            await logsRef.push(logEntry);
            return res.status(401).json({ result: 'refusal', message: '미등록 사용자' });
        }

        // 3. 딥러닝 서버로 데이터 전송 (axios 시뮬레이션)
        const requestPayload = {
            captured_image_url: captureData.imageUrl,
            captured_db_level: captureData.dB_level,
            registered_image_url: userData.registered_image_url,
            registered_db_level: userData.registered_voice_level,
            user_id: userDataKey 
        };
        
        let deepLearningResponse;
        
        try {
            // 실제 딥러닝 서버 호출 (주석 처리 또는 시뮬레이션)
            // deepLearningResponse = await axios.post(DEEP_LEARNING_SERVER_URL, requestPayload);
            
            // 시뮬레이션: 사용자 이름이 'approval'이면 성공, 아니면 실패
            const isApproval = username.toLowerCase().includes('approval') || username.toLowerCase().includes('승인');
            deepLearningResponse = { 
                data: {
                    match: isApproval,
                    confidence: isApproval ? 0.95 : 0.10,
                    face_match_status: isApproval ? 'MATCHED' : 'NOT_MATCHED',
                    voice_match_status: isApproval ? 'MATCHED' : 'NOT_MATCHED'
                }
            };

            console.log('딥러닝 서버 시뮬레이션 응답:', deepLearningResponse.data);

        } catch (dlError) {
            console.error('딥러닝 서버 호출 실패:', dlError.message);
            // 딥러닝 서버 통신 실패 시 거절 처리
            await controlsRef.child('door_state').set('refusal');
            return res.status(500).json({ error: '인증 서버 통신 오류' });
        }

        // 4. 딥러닝 서버 결과 처리 및 DB 업데이트
        const finalResult = deepLearningResponse.data.match ? 'approval' : 'refusal';
        const logMessage = `Face: ${deepLearningResponse.data.face_match_status}, Voice: ${deepLearningResponse.data.voice_match_status}, Conf: ${deepLearningResponse.data.confidence.toFixed(2)}`;

        const logEntry = {
            timestamp: new Date().toISOString(),
            result: finalResult,
            type: 'FACE_VOICE',
            username: username,
            logMessage: logMessage,
            imageUrl: captureData.imageUrl,
            dB_level: captureData.dB_level,
            timeMillis: admin.database.ServerValue.TIMESTAMP
        };

        await controlsRef.child('door_state').set(finalResult);
        await logsRef.push(logEntry);

        res.status(200).json({ result: finalResult, message: logMessage });

    } catch (error) {
        console.error('인증 프로세스 오류:', error);
        res.status(500).json({ error: '서버 내부 오류' });
    }
});


// -------------------- 사용자 관리 API (기존 로직 유지) --------------------

// 사용자 조회
app.get('/api/users', async (req, res) => {
    try {
        const ownerId = req.query.ownerId; 
        const snapshot = await usersRef.once('value');
        const allUsers = snapshot.val() || {};

        if (ownerId) {
            const filteredUsers = {};
            for (const [key, user] of Object.entries(allUsers)) {
                if (user.ownerId === ownerId || user.id === ownerId) {
                    filteredUsers[key] = user;
                }
            }
            res.status(200).json(filteredUsers);
        } else {
            res.status(200).json(allUsers);
        }
    } catch (error) {
        console.error('사용자 조회 오류:', error);
        res.status(500).json({ error: '서버 오류' });
    }
});

// 회원가입 및 사용자 추가
app.post('/api/users', async (req, res) => {
    try {
        // 1. 회원가입 (ID, PW, Username 필수)
        if (req.body.id && req.body.password && req.body.username) {
            const { id, username, password } = req.body;
            
            const idSnapshot = await usersRef.orderByChild('id').equalTo(id).once('value');
            if (idSnapshot.exists()) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
            
            const usernameSnapshot = await usersRef.orderByChild('username').equalTo(username).once('value');
            if (usernameSnapshot.exists()) return res.status(409).json({ error: '이미 사용 중인 이름입니다.' });

            const newUserRef = usersRef.push();
            await newUserRef.set({ 
                id, 
                username, 
                password,
                // [추가] 초기 등록 데이터 필드 (나중에 업데이트 필요)
                registered_image_url: null,
                registered_voice_level: null
            }); 
            return res.status(201).json({ id: newUserRef.key, message: '회원가입 성공' });
        } 
        
        // 2. 단순 사용자 추가 (Name, OwnerId 필수, ID/PW 없음)
        else if (req.body.name && req.body.ownerId && !req.body.id && !req.body.password) {
            const newUserRef = usersRef.push();
            const userData = {
                name: req.body.name,
                ownerId: req.body.ownerId, 
                imageUrl: req.body.imageUrl || null
            };
            await newUserRef.set(userData); 
            console.log("단순 사용자 추가됨:", userData.name, "Owner:", userData.ownerId);
            return res.status(201).json({ id: newUserRef.key, message: '사용자 추가 성공' });
        }

        else {
            return res.status(400).json({ error: '필수 정보가 부족하거나 형식이 잘못되었습니다.' });
        }

    } catch (error) {
        console.error('사용자 추가/가입 오류:', error);
        res.status(500).json({ error: '서버 오류' });
    }
});

// 사용자 정보 수정 (기존 로직 유지)
app.put('/api/users/:id', async (req, res) => {
    try {
        // 이 엔드포인트를 통해 registered_image_url 및 registered_voice_level을 업데이트할 수 있음
        await usersRef.child(req.params.id).update(req.body);
        res.status(200).send('수정 성공');
    } catch (error) {
        res.status(500).json({ error: '오류' });
    }
});

// 사용자 삭제 (기존 로직 유지)
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
