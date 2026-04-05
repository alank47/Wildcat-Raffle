        // ========================================
        // CLOUD SYNC CONFIGURATION - FIREBASE
        // ========================================
        // Firebase configuration for cloud storage
        const firebaseConfig = {
            apiKey: "AIzaSyDMbh3V117xbAHCYMVCwPUTNv9h1uEnFig",
            authDomain: "wildcat-hub-94025.firebaseapp.com",
            projectId: "wildcat-hub-94025",
            storageBucket: "wildcat-hub-94025.firebasestorage.app",
            messagingSenderId: "1085604958944",
            appId: "1:1085604958944:web:2f49395c2d4b0370187685"
        };
        
        // Firebase initialization - will be set up when page loads
        let firebaseApp = null;
        let firebaseDb = null;
        let firebaseInitialized = false;
        
        // Initialize Firebase
        async function initFirebase() {
            try {
                // Dynamically import Firebase modules
                const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js');
                const { getFirestore, doc, getDoc, setDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
                
                // Store imports globally
                window.firebaseModules = { doc, getDoc, setDoc, serverTimestamp };
                
                // Initialize Firebase app
                firebaseApp = initializeApp(firebaseConfig);
                firebaseDb = getFirestore(firebaseApp);
                firebaseInitialized = true;
                
                console.log('✅ Firebase initialized successfully');
                return true;
            } catch (error) {
                console.error('❌ Firebase initialization failed:', error);
                firebaseInitialized = false;
                return false;
            }
        }
        
        // DO NOT CHANGE ANYTHING BELOW THIS LINE
        // ========================================
        
        let students = [];
        let currentWeek = 1;
        let cycleDuration = 5; // Configurable: How many weeks in each Wildcat Jackpot cycle
        
        // ========================================
        // AUTOMATIC WEEK SYSTEM
        // ========================================
        let autoWeekEnabled = true; // Enable automatic week detection and reset
        let lastAutoResetDate = null; // Last date/time we ran auto reset (prevents double-processing)
        let weekResetDay = 1; // 0 = Sunday, 1 = Monday, 2 = Tuesday, etc.
        let weekResetHour = 6; // 6 AM
        
        // ========================================
        // JACKPOT CYCLE CONFIGURATION
        // ========================================
        let currentCycle = {
            name: 'Cycle 1',
            startDate: null, // Will be set in settings (YYYY-MM-DD format)
            endDate: null,   // Will be set in settings (YYYY-MM-DD format)
            cycleNumber: 1
        };
        let cycleHistory = []; // Archive of past cycles with their winners
        
        let lastAwardAction = null; // Track last ticket award for UNDO functionality
        let weeklyWinners = [];
        let bigRaffleWinners = [];
        let teachers = [];
        let auditLog = [];
        let currentUser = null;
        let currentStudent = null;
        let binId = '6987ac03ae596e708f191041'; // School database ID - hardcoded for auto-connect
        let isSyncing = false; // Prevent sync conflicts
        let lastSaveTimestamp = 0; // Track when we last saved data
        let lastUserActivity = Date.now(); // Track user activity
        let inactivityTimer = null;
        
        // ========================================
        // WILDCAT CASH SYSTEM (BETA - SUPERADMIN ONLY)
        // ========================================
        let wildcatCashEnabled = false; // Toggle between Raffle Mode and Bank Mode
        let disciplineModeEnabled = false; // Enable Discipline Mode
        
        // ========================================
        // SCHOOL BRANDING CONFIGURATION
        // ========================================
        let schoolBranding = {
            schoolName: '',
            mascot: 'Wildcat',
            logoBase64: '',
            colors: {
                primary: '#667eea',
                secondary: '#764ba2',
                accent: '#10b981'
            },
            terminology: {
                cashName: 'Wildcat Cash',
                jackpotName: 'Wildcat Jackpot',
                passName: 'ClawPass'
            }
        };

        // Behavior Referral System
        let behaviorReferrals = []; // Array of referral objects
        let referralIdCounter = 1;
        
        // Detention Tracker System
        let detentions = []; // Array of detention records
        let detentionIdCounter = 1;
        let detentionLocations = ['Main Office', 'Library', 'Room 101', 'Room 102', 'Cafeteria', 'Gym'];
        let detentionReasons = [
            'Disrupting Class',
            'Tardiness',
            'Dress Code Violation',
            'Inappropriate Behavior',
            'Defiance/Disrespect',
            'Cell Phone Violation',
            'Missing Assignment',
            'Other'
        ];
        
        // Login Activity Tracking
        let loginHistory = []; // Array of login records
        
        let wildcatCashBehaviors = [
            // Core Positive Behaviors (cannot be deleted)
            { id: 'wc1', name: 'Be Present', points: 100, type: 'positive' },
            { id: 'wc2', name: 'Be Respectful', points: 100, type: 'positive' },
            { id: 'wc3', name: 'Be Responsible', points: 100, type: 'positive' },
            { id: 'wc4', name: 'Be Safe', points: 100, type: 'positive' },
            // Core Negative Behaviors (cannot be deleted)
            { id: 'wc5', name: 'Not Being Present', points: -100, type: 'negative' },
            { id: 'wc6', name: 'Not Being Respectful', points: -100, type: 'negative' },
            { id: 'wc7', name: 'Not Being Responsible', points: -100, type: 'negative' },
            { id: 'wc8', name: 'Not Being Safe', points: -100, type: 'negative' }
        ];
        let wildcatCashRewards = [
            { id: 'reward1', name: 'Homework Pass', cost: 1000, available: true },
            { id: 'reward2', name: 'Dress Down Day', cost: 1500, available: true },
            { id: 'reward3', name: 'Lunch with Teacher', cost: 2000, available: true },
            { id: 'reward4', name: 'Front of Line Pass', cost: 500, available: true },
            { id: 'reward5', name: 'Extra Recess Time', cost: 750, available: true }
        ];
        let wildcatCashTransactions = []; // All transactions across all students
        let STARTING_BALANCE = 2500; // All students start with $2500 Wildcat Cash
        
        // Claw Pass (Digital Hall Pass) System Variables
        let hallPasses = []; // All hall passes (active and historical)
        let activeHallPasses = []; // Currently active passes
        let hallMonitorInterval = null; // Auto-refresh interval for Hall Monitor
        let passSettings = {
            bathroom: 5,      // minutes
            office: 10,       // minutes
            classroom: 15,    // minutes
            wellness: 20,     // minutes
            currentSchool: 'highschool', // Current school context: 'highschool' or 'middleschool'
            
            // Bell Schedule Configuration (ClawPass only)
            bellSchedules: {
                normal: {
                    name: "Normal Schedule",
                    periods: [
                        { period: "A1", start: "07:45", end: "08:15" },
                        { period: "P1", start: "08:20", end: "09:20" },
                        { period: "P2", start: "09:25", end: "10:25" },
                        { period: "P3", start: "10:30", end: "11:30" },
                        { period: "P4", start: "11:35", end: "12:35" },
                        { period: "HPU", start: "12:40", end: "13:10" },
                        { period: "P5", start: "13:15", end: "14:15" },
                        { period: "P6", start: "14:20", end: "15:20" },
                        { period: "A2", start: "15:25", end: "15:55" }
                    ]
                },
                minimumDay: {
                    name: "Minimum Day",
                    periods: [
                        { period: "A1", start: "07:45", end: "08:10" },
                        { period: "P1", start: "08:15", end: "08:55" },
                        { period: "P2", start: "09:00", end: "09:40" },
                        { period: "P3", start: "09:45", end: "10:25" },
                        { period: "P4", start: "10:30", end: "11:10" },
                        { period: "HPU", start: "11:15", end: "11:35" },
                        { period: "P5", start: "11:40", end: "12:20" },
                        { period: "P6", start: "12:25", end: "13:05" },
                        { period: "A2", start: "13:10", end: "13:30" }
                    ]
                },
                assembly: {
                    name: "Assembly Schedule",
                    periods: [
                        { period: "A1", start: "07:45", end: "08:10" },
                        { period: "P1", start: "08:15", end: "08:50" },
                        { period: "P2", start: "08:55", end: "09:30" },
                        { period: "Assembly", start: "09:35", end: "10:35" },
                        { period: "P3", start: "10:40", end: "11:15" },
                        { period: "P4", start: "11:20", end: "11:55" },
                        { period: "HPU", start: "12:00", end: "12:30" },
                        { period: "P5", start: "12:35", end: "13:10" },
                        { period: "P6", start: "13:15", end: "13:50" },
                        { period: "A2", start: "13:55", end: "14:15" }
                    ]
                }
            },
            activeSchedule: "normal", // Which schedule is active today
            enableAutoDetection: true // Auto-detect period from schedule
        };
        let currentPassTimer = null; // Timer for active pass display
        let selectedKioskStudent = null; // Student creating pass at kiosk
        let currentActivePass = null; // Currently displayed pass in modal
        
        // Kickboard Point Conversion Settings
        let kickboardSettings = {
            pbisPoints: 500,        // $500 Kickboard per PBIS ticket
            attendancePoints: 500,  // $500 Kickboard per Attendance ticket
            academicPoints: 500,    // $500 Kickboard per Academic ticket
            emailDay: 5,            // Friday = 5 (0=Sunday, 1=Monday, etc)
            emailHour: 16,          // 4:00 PM = 16 (24-hour format)
            emailSubject: 'Your Weekly Raffle Ticket Summary'
        };
        
        // EmailJS Configuration
        let emailJSConfig = {
            serviceId: '',      // Will be set in Settings
            templateId: '',     // Will be set in Settings
            publicKey: ''       // Will be set in Settings
        };
        let weeklyHistory = []; // Track historical week data
        let autoRefreshInterval = null; // Store interval ID
        let pbisSubcategories = ['Being Present', 'Being Responsible', 'Being Respectful', 'Being Safe'];
        let academicSubcategories = ['No Missing Assignments', 'Improvement on quiz/assessment or successful retakes', 'Participation in tutoring'];
        let lastPowerSchoolSync = null; // Track last sync time
        let csvScheduleData = new Map(); // Store teacher-section mappings from CSV
        const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
        const AUTO_REFRESH_DELAY = 300000; // Only auto-refresh after 5 minutes of inactivity (reduced conflicts)
        
        // PowerSchool API Configuration
        const POWERSCHOOL_BASE_URL = 'https://lapf.powerschool.com/westbrookraffleapi/';
        const POWERSCHOOL_API_KEY = 'mhlkugli76_986g7g60p';

        // Session management functions
        function saveSession() {
            if (currentUser) {
                sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
                sessionStorage.setItem('lastActivity', Date.now());
            } else if (currentStudent) {
                sessionStorage.setItem('currentStudent', JSON.stringify(currentStudent));
                sessionStorage.setItem('lastActivity', Date.now());
            }
        }

        function loadSession() {
            const lastActivity = sessionStorage.getItem('lastActivity');
            
            // Check if session expired (more than 30 minutes)
            if (lastActivity && (Date.now() - parseInt(lastActivity) > INACTIVITY_TIMEOUT)) {
                clearSession();
                return false;
            }

            const savedUser = sessionStorage.getItem('currentUser');
            const savedStudent = sessionStorage.getItem('currentStudent');
            
            if (savedUser) {
                const sessionUser = JSON.parse(savedUser);
                // Sync with live teachers array to get updated data
                const liveTeacher = teachers.find(t => t.id === sessionUser.id);
                if (liveTeacher) {
                    currentUser = liveTeacher;
                    saveSession(); // Update session with fresh data
                } else {
                    currentUser = sessionUser; // Fallback if not found
                }
                resetInactivityTimer();
                return true;
            } else if (savedStudent) {
                currentStudent = JSON.parse(savedStudent);
                resetInactivityTimer();
                return true;
            }
            
            return false;
        }

        function clearSession() {
            sessionStorage.removeItem('currentUser');
            sessionStorage.removeItem('currentStudent');
            sessionStorage.removeItem('lastActivity');
            if (inactivityTimer) {
                clearTimeout(inactivityTimer);
            }
        }

        function resetInactivityTimer() {
            // Clear existing timer
            if (inactivityTimer) {
                clearTimeout(inactivityTimer);
            }
            
            // Update last activity time
            sessionStorage.setItem('lastActivity', Date.now());
            
            // Set new timer
            inactivityTimer = setTimeout(() => {
                alert('You have been logged out due to inactivity.');
                logout();
            }, INACTIVITY_TIMEOUT);
        }

        // Track user activity to reset timer
        function setupActivityListeners() {
            const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
            
            events.forEach(event => {
                document.addEventListener(event, () => {
                    lastUserActivity = Date.now(); // Update activity timestamp
                    
                    if (currentUser || currentStudent) {
                        resetInactivityTimer();
                    }
                }, true);
            });
        }

        // Login toggle functions
        function showTeacherLogin() {
            document.getElementById('teacherLoginForm').classList.remove('hidden');
            document.getElementById('studentLoginForm').classList.add('hidden');
            document.getElementById('teacherLoginBtn').style.cssText = 'flex:1;padding:10px;border:none;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer;transition:all 0.2s;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;box-shadow:0 2px 8px rgba(102,126,234,0.3);';
            document.getElementById('studentLoginBtn').style.cssText = 'flex:1;padding:10px;border:none;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer;transition:all 0.2s;background:transparent;color:#888;';
        }

        function showStudentLogin() {
            document.getElementById('studentLoginForm').classList.remove('hidden');
            document.getElementById('teacherLoginForm').classList.add('hidden');
            document.getElementById('studentLoginBtn').style.cssText = 'flex:1;padding:10px;border:none;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer;transition:all 0.2s;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;box-shadow:0 2px 8px rgba(102,126,234,0.3);';
            document.getElementById('teacherLoginBtn').style.cssText = 'flex:1;padding:10px;border:none;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer;transition:all 0.2s;background:transparent;color:#888;';
        }


        function studentLogin() {
            const input = document.getElementById('studentLoginId').value.trim();
            const errorDiv = document.getElementById('studentLoginError');

            if (!input) {
                errorDiv.textContent = 'Please enter your Student ID or name';
                return;
            }

            // Search by ID or name
            const student = students.find(s => 
                s.id.toLowerCase() === input.toLowerCase() ||
                `${s.firstName} ${s.lastName}`.toLowerCase() === input.toLowerCase() ||
                s.firstName.toLowerCase() === input.toLowerCase() ||
                s.lastName.toLowerCase() === input.toLowerCase()
            );

            if (!student) {
                errorDiv.textContent = 'Student not found. Please check your ID or name.';
                return;
            }

            currentStudent = student;
            saveSession(); // Save session for auto-login
            
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('createAdminScreen').classList.add('hidden');
            document.getElementById('studentApp').classList.remove('hidden');
            
            updateStudentView();
        }

        function updateStudentView() {
            document.getElementById('studentViewName').textContent = `${currentStudent.firstName} ${currentStudent.lastName}`;
            document.getElementById('studentViewId').textContent = currentStudent.id;
            document.getElementById('studentPbisTickets').textContent = currentStudent.pbisTickets;
            document.getElementById('studentAttendanceTickets').textContent = currentStudent.attendanceTickets;
            document.getElementById('studentAcademicTickets').textContent = currentStudent.academicTickets;

            // Show qualified banner - check BOTH if already qualified OR if currently has all 3 ticket types
            const hasAllThreeTickets = currentStudent.pbisTickets > 0 && 
                                       currentStudent.attendanceTickets > 0 && 
                                       currentStudent.academicTickets > 0;
            
            if (currentStudent.bigRaffleQualified || hasAllThreeTickets) {
                document.getElementById('qualifiedBanner').classList.remove('hidden');
            } else {
                document.getElementById('qualifiedBanner').classList.add('hidden');
            }
            
            // Update student leaderboards (this will set the level text and color)
            updateStudentLeaderboards();

            // Update ticket history
            const tbody = document.getElementById('studentHistoryTable');
            const history = currentStudent.ticketHistory || [];

            if (history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 40px; color: #999;">No tickets received yet. Keep up the good work!</td></tr>';
            } else {
                tbody.innerHTML = [...history].reverse().map(h => {
                    const date = new Date(h.timestamp);
                    return `
                        <tr>
                            <td>${date.toLocaleDateString()}</td>
                            <td>${h.category}</td>
                            <td>${h.tickets}</td>
                            <td>${h.reason || '-'}</td>
                            <td>${h.teacher}</td>
                        </tr>
                    `;
                }).join('');
            }

            // Update Wildcat Cash tab
            updateStudentCashView();
            
            // Update Claw Pass tab
            updateStudentPassView();
        }

        function switchStudentTab(tabName) {
            // Hide all tabs
            document.querySelectorAll('.student-tab-content').forEach(tab => tab.style.display = 'none');
            document.querySelectorAll('.student-tab-button').forEach(btn => {
                btn.style.background = '#f5f5f5';
                btn.style.color = '#333';
                btn.classList.remove('active');
            });
            
            // Show selected tab
            document.getElementById(tabName + 'Tab').style.display = 'block';
            const btnId = tabName === 'raffleTickets' ? 'studentRaffleTabBtn' : 
                          tabName === 'wildcatCash' ? 'studentCashTabBtn' : 'studentPassTabBtn';
            const btn = document.getElementById(btnId);
            btn.style.background = '#667eea';
            btn.style.color = 'white';
            btn.classList.add('active');
            
            // Refresh data for the selected tab
            if (tabName === 'wildcatCash') {
                updateStudentCashView();
            } else if (tabName === 'clawPass') {
                updateStudentPassView();
            }
        }

        function updateStudentCashView() {
            if (!currentStudent) return;
            
            // Initialize if needed
            if (currentStudent.wildcatCashBalance === undefined) {
                currentStudent.wildcatCashBalance = STARTING_BALANCE;
                currentStudent.wildcatCashEarned = 0;
                currentStudent.wildcatCashSpent = 0;
                currentStudent.wildcatCashDeducted = 0;
                currentStudent.wildcatCashTransactions = [];
            }
            
            // Update balance
            document.getElementById('studentCashBalance').textContent = '$' + currentStudent.wildcatCashBalance;
            document.getElementById('studentCashEarned').textContent = '$' + currentStudent.wildcatCashEarned;
            document.getElementById('studentCashSpent').textContent = '$' + currentStudent.wildcatCashSpent;
            document.getElementById('studentCashDeducted').textContent = '$' + currentStudent.wildcatCashDeducted;
            
            // Update transactions
            const transactionsContainer = document.getElementById('studentCashTransactions');
            const transactions = (currentStudent.wildcatCashTransactions || []).slice().reverse().slice(0, 10); // Last 10 transactions
            
            if (transactions.length === 0) {
                transactionsContainer.innerHTML = '<p style="text-align: center; color: #999; padding: 40px;">No transactions yet</p>';
                return;
            }
            
            transactionsContainer.innerHTML = transactions.map(txn => {
                const date = new Date(txn.timestamp);
                const color = txn.amount > 0 ? '#10b981' : '#ef4444';
                const sign = txn.amount > 0 ? '+' : '';
                return `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px; border-bottom: 1px solid #e0e0e0;">
                        <div>
                            <div style="font-weight: 600; color: #333; margin-bottom: 4px;">${txn.behaviorName}</div>
                            <div style="font-size: 13px; color: #999;">${date.toLocaleDateString()} ${date.toLocaleTimeString()}</div>
                            ${txn.notes ? `<div style="font-size: 13px; color: #666; margin-top: 4px;">${txn.notes}</div>` : ''}
                        </div>
                        <div style="font-size: 24px; font-weight: 700; color: ${color};">${sign}$${Math.abs(txn.amount)}</div>
                    </div>
                `;
            }).join('');
        }

        function updateStudentPassView() {
            if (!currentStudent) return;
            
            const studentPasses = hallPasses.filter(p => p.studentId === currentStudent.id);
            const activePasses = studentPasses.filter(p => p.status === 'active' && new Date(p.expiresAt) > new Date());
            
            // Update active pass section
            const activePassContainer = document.getElementById('studentActivePass');
            if (activePasses.length > 0) {
                const pass = activePasses[0]; // Show first active pass
                const now = new Date();
                const remaining = new Date(pass.expiresAt) - now;
                const minutes = Math.floor(remaining / 60000);
                const seconds = Math.floor((remaining % 60000) / 1000);
                const timeColor = minutes === 0 ? '#ffc107' : '#10b981';
                
                activePassContainer.innerHTML = `
                    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3); color: white; text-align: center;">
                        <h3 style="margin: 0 0 20px 0; font-size: 24px;">🎫 Active Pass</h3>
                        <div style="font-size: 48px; font-weight: 700; color: ${timeColor}; margin-bottom: 10px;">${minutes}:${seconds.toString().padStart(2, '0')}</div>
                        <div style="font-size: 16px; margin-bottom: 20px;">Time Remaining</div>
                        <div style="background: rgba(255,255,255,0.2); padding: 15px; border-radius: 8px;">
                            <div style="margin-bottom: 8px;"><strong>Destination:</strong> ${getDestinationDisplay(pass.destination)}</div>
                            <div style="margin-bottom: 8px;"><strong>Started:</strong> ${new Date(pass.createdAt).toLocaleTimeString()}</div>
                            <div><strong>Expires:</strong> ${new Date(pass.expiresAt).toLocaleTimeString()}</div>
                        </div>
                    </div>
                `;
            } else {
                activePassContainer.innerHTML = '';
            }
            
            // Update pass history
            const historyTable = document.getElementById('studentPassHistory');
            if (studentPasses.length === 0) {
                historyTable.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 40px; color: #999;">No hall passes yet</td></tr>';
                return;
            }
            
            historyTable.innerHTML = studentPasses.slice().reverse().map(pass => {
                const statusColor = pass.status === 'returned' ? '#10b981' : 
                                   pass.status === 'expired' ? '#ef4444' : '#ffc107';
                const statusText = pass.status === 'returned' ? '✅ Returned' :
                                  pass.status === 'expired' ? '⏰ Expired' : '🟡 Active';
                
                return `
                    <tr>
                        <td style="padding: 12px;">${new Date(pass.createdAt).toLocaleString()}</td>
                        <td style="padding: 12px;">${getDestinationDisplay(pass.destination)}</td>
                        <td style="padding: 12px;">${pass.duration} min</td>
                        <td style="padding: 12px; color: ${statusColor}; font-weight: 600;">${statusText}</td>
                    </tr>
                `;
            }).join('');
        }

        function updateStudentLeaderboards() {
            // Determine if current student is MS (6-8) or HS (9-12)
            const currentGrade = parseInt(currentStudent.grade);
            const isMiddleSchool = currentGrade >= 6 && currentGrade <= 8;
            const isHighSchool = currentGrade >= 9 && currentGrade <= 12;
            
            // Filter students to only show same level (MS or HS)
            let relevantStudents = students;
            if (isMiddleSchool) {
                relevantStudents = students.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 6 && grade <= 8;
                });
            } else if (isHighSchool) {
                relevantStudents = students.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 9 && grade <= 12;
                });
            }
            
            // Set the school level header text and color
            const levelElement = document.getElementById('studentLeaderboardLevel');
            let schoolColor, schoolGradient1, schoolGradient2, schoolName;
            
            if (isMiddleSchool) {
                schoolColor = '#ff9800';
                schoolGradient1 = '#ff9800';
                schoolGradient2 = '#f57c00';
                schoolName = '🎓 Middle School (Grades 6-8)';
                levelElement.style.color = '#ff9800';
            } else if (isHighSchool) {
                schoolColor = '#3b82f6';
                schoolGradient1 = '#3b82f6';
                schoolGradient2 = '#2563eb';
                schoolName = '🏫 High School (Grades 9-12)';
                levelElement.style.color = '#3b82f6';
            }
            levelElement.textContent = schoolName;
            
            // Calculate overall leader (total of all tickets)
            const overallTop = [...relevantStudents]
                .map(s => ({
                    ...s,
                    totalTickets: (s.pbisTickets || 0) + (s.attendanceTickets || 0) + (s.academicTickets || 0)
                }))
                .filter(s => s.totalTickets > 0)
                .sort((a, b) => b.totalTickets - a.totalTickets)
                .slice(0, 10);
            
            // Get top student for each category
            const pbisTop = [...relevantStudents]
                .filter(s => (s.pbisTickets || 0) > 0)
                .sort((a, b) => (b.pbisTickets || 0) - (a.pbisTickets || 0));
            
            const attendanceTop = [...relevantStudents]
                .filter(s => (s.attendanceTickets || 0) > 0)
                .sort((a, b) => (b.attendanceTickets || 0) - (a.attendanceTickets || 0));
            
            const academicTop = [...relevantStudents]
                .filter(s => (s.academicTickets || 0) > 0)
                .sort((a, b) => (b.academicTickets || 0) - (a.academicTickets || 0));

            // Build the complete leaderboard HTML matching the new design
            const leaderboardHTML = `
                <div style="background: linear-gradient(135deg, ${schoolGradient1} 0%, ${schoolGradient2} 100%); padding: 4px; border-radius: 16px; box-shadow: 0 6px 20px rgba(${isMiddleSchool ? '255, 152, 0' : '59, 130, 246'}, 0.3);">
                    <div style="background: white; border-radius: 12px; padding: 25px;">
                        
                        <!-- Overall Leader Card -->
                        <div style="background: linear-gradient(135deg, ${schoolGradient1} 0%, ${schoolGradient2} 100%); padding: 20px; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 4px 12px rgba(${isMiddleSchool ? '255, 152, 0' : '59, 130, 246'}, 0.2);">
                            <h4 style="color: white; margin: 0 0 15px 0; text-align: center; font-size: 18px; font-weight: 600;">🏆 Overall Leader</h4>
                            <div style="background: rgba(255,255,255,0.95); border-radius: 8px; padding: 15px;">
                                <table style="width: 100%;">
                                    <thead>
                                        <tr style="border-bottom: 2px solid ${schoolColor};">
                                            <th style="text-align: left; padding: 8px; color: #333; font-weight: 600; font-size: 13px;">Rank</th>
                                            <th style="text-align: left; padding: 8px; color: #333; font-weight: 600; font-size: 13px;">Student</th>
                                            <th style="text-align: right; padding: 8px; color: #333; font-weight: 600; font-size: 13px;">Total</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${overallTop.length === 0 ? 
                                            '<tr><td colspan="3" style="text-align: center; padding: 20px; color: #999;">No tickets awarded yet</td></tr>' :
                                            overallTop.map((s, i) => {
                                                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                                                const isCurrentStudent = s.id === currentStudent.id;
                                                const highlightStyle = isCurrentStudent ? 'background: #fff3cd; font-weight: bold;' : '';
                                                return `
                                                    <tr style="${highlightStyle}">
                                                        <td style="padding: 8px; font-size: 16px;">${medal}</td>
                                                        <td style="padding: 8px; font-weight: 600;">${s.firstName} ${s.lastName.charAt(0)}.${isCurrentStudent ? ' (You!)' : ''}</td>
                                                        <td style="padding: 8px; text-align: right; font-weight: bold; color: ${schoolColor}; font-size: 16px;">${s.totalTickets} 🎫</td>
                                                    </tr>
                                                `;
                                            }).join('')
                                        }
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        
                        <!-- Category Leaders -->
                        <div style="display: grid; gap: 15px;">
                            <!-- PBIS -->
                            <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; border-left: 4px solid #ef4444;">
                                <h5 style="margin: 0 0 10px 0; color: #ef4444; font-size: 15px; font-weight: 600;">🎯 PBIS Leader</h5>
                                <div style="color: #333; font-size: 14px;">
                                    ${pbisTop.length === 0 ? 
                                        '<span style="color: #999; font-style: italic;">No tickets yet</span>' :
                                        (() => {
                                            const top = pbisTop[0];
                                            const isYou = top.id === currentStudent.id;
                                            return `<strong>${top.firstName} ${top.lastName.charAt(0)}.</strong> - ${top.pbisTickets} 🎫${isYou ? ' <span style="color: #ef4444; font-weight: 700;">(You!)</span>' : ''}`;
                                        })()
                                    }
                                </div>
                            </div>
                            
                            <!-- Attendance -->
                            <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; border-left: 4px solid #10b981;">
                                <h5 style="margin: 0 0 10px 0; color: #10b981; font-size: 15px; font-weight: 600;">📅 Attendance Leader</h5>
                                <div style="color: #333; font-size: 14px;">
                                    ${attendanceTop.length === 0 ? 
                                        '<span style="color: #999; font-style: italic;">No tickets yet</span>' :
                                        (() => {
                                            const top = attendanceTop[0];
                                            const isYou = top.id === currentStudent.id;
                                            return `<strong>${top.firstName} ${top.lastName.charAt(0)}.</strong> - ${top.attendanceTickets} 🎫${isYou ? ' <span style="color: #10b981; font-weight: 700;">(You!)</span>' : ''}`;
                                        })()
                                    }
                                </div>
                            </div>
                            
                            <!-- Academic -->
                            <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; border-left: 4px solid #3b82f6;">
                                <h5 style="margin: 0 0 10px 0; color: #3b82f6; font-size: 15px; font-weight: 600;">📚 Academic Leader</h5>
                                <div style="color: #333; font-size: 14px;">
                                    ${academicTop.length === 0 ? 
                                        '<span style="color: #999; font-style: italic;">No tickets yet</span>' :
                                        (() => {
                                            const top = academicTop[0];
                                            const isYou = top.id === currentStudent.id;
                                            return `<strong>${top.firstName} ${top.lastName.charAt(0)}.</strong> - ${top.academicTickets} 🎫${isYou ? ' <span style="color: #3b82f6; font-weight: 700;">(You!)</span>' : ''}`;
                                        })()
                                    }
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            // Inject the HTML into the container
            document.getElementById('studentLeaderboardContainer').innerHTML = leaderboardHTML;
        }

        // Cloud Sync Functions
        async function loadData() {
            // Initialize Firebase first
            await initFirebase();
            
            // Try to load from Firebase - LOAD FROM MULTIPLE DOCUMENTS
            if (firebaseInitialized && firebaseDb) {
                try {
                    const { doc, getDoc } = window.firebaseModules;
                    
                    // Load both documents in parallel
                    const [mainSnap, secondarySnap] = await Promise.all([
                        getDoc(doc(firebaseDb, 'raffle_data', 'main')),
                        getDoc(doc(firebaseDb, 'raffle_data', 'secondary'))
                    ]);
                    
                    // Check if we have data (at least main document should exist)
                    if (mainSnap.exists()) {
                        const mainData = mainSnap.data();
                        const secondaryData = secondarySnap.exists() ? secondarySnap.data() : {};
                        
                        // Load from main document
                        students = mainData.students || [];
                        currentWeek = mainData.currentWeek || 1;
                        cycleDuration = mainData.cycleDuration || 5;
                        teachers = mainData.teachers || [];
                        pbisSubcategories = mainData.pbisSubcategories || ['Being Present', 'Being Responsible', 'Being Respectful', 'Being Safe'];
                        academicSubcategories = mainData.academicSubcategories || ['No Missing Assignments', 'Improvement on quiz/assessment or successful retakes', 'Participation in tutoring'];
                        lastPowerSchoolSync = mainData.lastPowerSchoolSync || null;
                        kickboardSettings = mainData.kickboardSettings || kickboardSettings;
                        emailJSConfig = mainData.emailJSConfig || emailJSConfig;
                        passSettings = mainData.passSettings || passSettings;
                        schoolBranding = mainData.schoolBranding || schoolBranding;
                        referralIdCounter = mainData.referralIdCounter || 1;
                        lastSaveTimestamp = mainData.lastSaveTimestamp || 0;
                        // Auto-week system
                        autoWeekEnabled = mainData.autoWeekEnabled !== undefined ? mainData.autoWeekEnabled : true;
                        lastAutoResetDate = mainData.lastAutoResetDate || null;
                        weekResetDay = mainData.weekResetDay !== undefined ? mainData.weekResetDay : 1;
                        weekResetHour = mainData.weekResetHour !== undefined ? mainData.weekResetHour : 6;
                        // Jackpot cycles
                        currentCycle = mainData.currentCycle || { name: 'Cycle 1', startDate: null, endDate: null, cycleNumber: 1 };
                        cycleHistory = mainData.cycleHistory || [];
                        
                        // Load from secondary document
                        weeklyWinners = secondaryData.weeklyWinners || [];
                        bigRaffleWinners = secondaryData.bigRaffleWinners || [];
                        weeklyHistory = secondaryData.weeklyHistory || [];
                        auditLog = secondaryData.auditLog || [];
                        loginHistory = secondaryData.loginHistory || [];
                        hallPasses = secondaryData.hallPasses || [];
                        preventionGroups = secondaryData.preventionGroups || [];
                        behaviorReferrals = secondaryData.behaviorReferrals || [];
                        detentions = secondaryData.detentions || [];
                        detentionLocations = secondaryData.detentionLocations || ['Main Office', 'Library', 'Room 101', 'Room 102', 'Cafeteria', 'Gym'];
                        detentionReasons = secondaryData.detentionReasons || ['Disrupting Class', 'Tardiness', 'Dress Code Violation', 'Inappropriate Behavior', 'Defiance/Disrespect', 'Cell Phone Violation', 'Missing Assignment', 'Other'];
                        
                        console.log('✅ Loaded data from Firebase (2 documents)');
                        
                        // Apply school branding
                        if (schoolBranding && (schoolBranding.schoolName || schoolBranding.logoBase64)) {
                            applyBranding(schoolBranding);
                        }
                        
                        // Ensure bell schedules exist
                        ensureBellSchedulesExist();
                        
                        // Update active hall passes
                        activeHallPasses = hallPasses.filter(p => p.status === 'active');
                        
                        // Initialize EmailJS if configured
                        if (emailJSConfig.publicKey && typeof emailjs !== 'undefined') {
                            emailjs.init(emailJSConfig.publicKey);
                        }
                        
                        return; // Successfully loaded from Firebase
                    } else {
                        console.log('ℹ️ No Firebase data found, loading from localStorage');
                        loadDataLocal();
                    }
                } catch (error) {
                    console.error('❌ Firebase load error:', error);
                    loadDataLocal();
                }
            } else {
                console.log('ℹ️ Firebase not initialized, loading from localStorage');
                loadDataLocal();
            }
        }

        function loadDataLocal() {
            const saved = localStorage.getItem('raffleData');
            if (saved) {
                const data = JSON.parse(saved);
                students = data.students || [];
                currentWeek = data.currentWeek || 1;
                cycleDuration = data.cycleDuration || 5;
                weeklyWinners = data.weeklyWinners || [];
                bigRaffleWinners = data.bigRaffleWinners || [];
                teachers = data.teachers || [];
                auditLog = data.auditLog || [];
                weeklyHistory = data.weeklyHistory || [];
                pbisSubcategories = data.pbisSubcategories || ['Being Present', 'Being Responsible', 'Being Respectful', 'Being Safe'];
                academicSubcategories = data.academicSubcategories || ['No Missing Assignments', 'Improvement on quiz/assessment or successful retakes', 'Participation in tutoring'];
                lastPowerSchoolSync = data.lastPowerSchoolSync || null;
                kickboardSettings = data.kickboardSettings || kickboardSettings;
                emailJSConfig = data.emailJSConfig || emailJSConfig;
                hallPasses = data.hallPasses || [];
                passSettings = data.passSettings || passSettings;
                preventionGroups = data.preventionGroups || [];
                schoolBranding = data.schoolBranding || schoolBranding;
                behaviorReferrals = data.behaviorReferrals || [];
                referralIdCounter = data.referralIdCounter || 1;
                detentions = data.detentions || [];
                detentionIdCounter = data.detentionIdCounter || 1;
                detentionLocations = data.detentionLocations || ['Main Office', 'Library', 'Room 101', 'Room 102', 'Cafeteria', 'Gym'];
                detentionReasons = data.detentionReasons || ['Disrupting Class', 'Tardiness', 'Dress Code Violation', 'Inappropriate Behavior', 'Defiance/Disrespect', 'Cell Phone Violation', 'Missing Assignment', 'Other'];
                loginHistory = data.loginHistory || [];
                lastSaveTimestamp = data.lastSaveTimestamp || 0;
                // Auto-week system
                autoWeekEnabled = data.autoWeekEnabled !== undefined ? data.autoWeekEnabled : true;
                lastAutoResetDate = data.lastAutoResetDate || null;
                weekResetDay = data.weekResetDay !== undefined ? data.weekResetDay : 1;
                weekResetHour = data.weekResetHour !== undefined ? data.weekResetHour : 6;
                // Jackpot cycles
                currentCycle = data.currentCycle || { name: 'Cycle 1', startDate: null, endDate: null, cycleNumber: 1 };
                cycleHistory = data.cycleHistory || [];
                
                // Apply school branding if it exists
                if (schoolBranding && (schoolBranding.schoolName || schoolBranding.logoBase64)) {
                    applyBranding(schoolBranding);
                }
                
                // Ensure bell schedules exist (initialize if needed)
                ensureBellSchedulesExist();
                
                // Update active hall passes
                activeHallPasses = hallPasses.filter(p => p.status === 'active');
                
                // Initialize EmailJS if configured
                if (emailJSConfig.publicKey && typeof emailjs !== 'undefined') {
                    emailjs.init(emailJSConfig.publicKey);
                }
            }
        }

        // ========================================
        // KICKBOARD & EMAILJS FUNCTIONS
        // ========================================
        
        function saveCycleDuration() {
            const newDuration = parseInt(document.getElementById('cycleDurationInput').value);
            
            if (!newDuration || newDuration < 1 || newDuration > 10) {
                alert('⚠️ Please enter a valid cycle duration between 1 and 10 weeks');
                return;
            }
            
            // Warn if current week exceeds new duration
            if (currentWeek > newDuration) {
                if (!confirm(`⚠️ WARNING: Current week (${currentWeek}) is greater than new cycle duration (${newDuration}).\n\nThis means you're already past the end of the cycle with this new setting.\n\nYou should probably:\n1. Run the Wildcat Jackpot now\n2. Click "End Week" to reset to Week 1\n3. Then set your new cycle duration\n\nDo you still want to change the cycle duration to ${newDuration} weeks?`)) {
                    return;
                }
            }
            
            cycleDuration = newDuration;
            document.getElementById('cycleDurationDisplay').textContent = cycleDuration;
            
            saveData();
            updateAllDisplays();
            
            alert(`✅ Cycle duration updated to ${cycleDuration} weeks!\n\nThis change is now active for the current cycle.\n\nCurrent status: Week ${currentWeek} of ${cycleDuration}`);
        }
        
        // ========================================
        // AUTO-WEEK SYSTEM SETTINGS
        // ========================================
        
        function toggleAutoWeek() {
            autoWeekEnabled = document.getElementById('autoWeekToggle').checked;
            const settingsDiv = document.getElementById('autoWeekSettings');
            
            if (autoWeekEnabled) {
                settingsDiv.style.display = 'block';
                console.log('✅ Auto-week system enabled');
            } else {
                settingsDiv.style.display = 'none';
                console.log('⚠️ Auto-week system disabled - you must manually complete weeks');
            }
            
            saveData();
        }
        
        function saveAutoWeekSettings() {
            weekResetDay = parseInt(document.getElementById('weekResetDaySelect').value);
            weekResetHour = parseInt(document.getElementById('weekResetHourSelect').value);
            
            updateAutoResetDisplay();
            saveData();
            
            console.log(`✅ Auto-week reset configured for ${getDayName(weekResetDay)} at ${weekResetHour}:00`);
        }
        
        function updateAutoResetDisplay() {
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const hours = ['12:00 AM', '1:00 AM', '2:00 AM', '3:00 AM', '4:00 AM', '5:00 AM', '6:00 AM', 
                          '7:00 AM', '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM'];
            
            document.getElementById('autoResetDayDisplay').textContent = days[weekResetDay];
            document.getElementById('autoResetTimeDisplay').textContent = hours[weekResetHour];
            
            if (lastAutoResetDate) {
                const date = new Date(lastAutoResetDate);
                document.getElementById('lastResetDisplay').textContent = date.toLocaleString();
            } else {
                document.getElementById('lastResetDisplay').textContent = 'Never';
            }
        }
        
        function saveCycleConfiguration() {
            const cycleName = document.getElementById('cycleNameInput').value || 'Cycle 1';
            const startDate = document.getElementById('cycleStartDate').value;
            const endDate = document.getElementById('cycleEndDate').value;
            
            if (!startDate || !endDate) {
                alert('⚠️ Please set both start and end dates for the cycle');
                return;
            }
            
            if (new Date(startDate) >= new Date(endDate)) {
                alert('⚠️ End date must be after start date');
                return;
            }
            
            currentCycle = {
                name: cycleName,
                startDate: startDate,
                endDate: endDate,
                cycleNumber: (currentCycle.cycleNumber || 0) + 1
            };
            
            updateCycleDisplay();
            saveData();
            
            alert(`✅ Jackpot Cycle configured!\n\n${cycleName}\nStart: ${new Date(startDate).toLocaleDateString()}\nEnd: ${new Date(endDate).toLocaleDateString()}`);
        }
        
        function updateCycleDisplay() {
            if (currentCycle.startDate && currentCycle.endDate) {
                document.getElementById('currentCycleName').textContent = currentCycle.name;
                document.getElementById('currentCycleDates').textContent = 
                    `${new Date(currentCycle.startDate).toLocaleDateString()} - ${new Date(currentCycle.endDate).toLocaleDateString()}`;
            } else {
                document.getElementById('currentCycleName').textContent = 'Not configured';
                document.getElementById('currentCycleDates').textContent = 'No dates set';
            }
        }
        
        function saveKickboardSettings() {
            kickboardSettings.pbisPoints = parseInt(document.getElementById('pbisKickboardPoints').value) || 500;
            kickboardSettings.attendancePoints = parseInt(document.getElementById('attendanceKickboardPoints').value) || 500;
            kickboardSettings.academicPoints = parseInt(document.getElementById('academicKickboardPoints').value) || 500;
            
            saveData();
            alert('✅ Kickboard point settings saved!');
        }
        
        function saveEmailJSConfig() {
            emailJSConfig.serviceId = document.getElementById('emailJSServiceId').value.trim();
            emailJSConfig.templateId = document.getElementById('emailJSTemplateId').value.trim();
            emailJSConfig.publicKey = document.getElementById('emailJSPublicKey').value.trim();
            
            if (!emailJSConfig.serviceId || !emailJSConfig.templateId || !emailJSConfig.publicKey) {
                alert('⚠️ Please fill in all EmailJS fields');
                return;
            }
            
            // Initialize EmailJS
            if (typeof emailjs !== 'undefined') {
                emailjs.init(emailJSConfig.publicKey);
            }
            
            saveData();
            alert('✅ EmailJS configuration saved!');
        }
        
        async function testEmailJS() {
            if (typeof emailjs === 'undefined') {
                alert('⚠️ EmailJS library not loaded.\n\nPlease refresh the page.');
                return;
            }
            
            if (!emailJSConfig.serviceId || !emailJSConfig.templateId || !emailJSConfig.publicKey) {
                alert('⚠️ Please configure EmailJS settings first');
                return;
            }
            
            // Refresh current user data from teachers array
            const updatedUser = teachers.find(t => t.id === currentUser.id);
            if (updatedUser) {
                currentUser = updatedUser;
            }
            
            if (!currentUser.email || currentUser.email === '') {
                alert('⚠️ Current user has no email address.\n\nPlease add an email to your account first.\n\nGo to Teachers tab → Click Edit on your account → Add email.');
                return;
            }
            
            try {
                const testReport = generateWeeklyReport(currentUser);
                
                await emailjs.send(
                    emailJSConfig.serviceId,
                    emailJSConfig.templateId,
                    {
                        to_email: currentUser.email,
                        to_name: currentUser.name,
                        subject: kickboardSettings.emailSubject,
                        week_number: currentWeek,
                        report_content: testReport
                    },
                    emailJSConfig.publicKey
                );
                
                alert(`✅ Test email sent to ${currentUser.email}!\n\nCheck your inbox.`);
            } catch (error) {
                console.error('Email test failed:', error);
                alert(`❌ Failed to send test email:\n\n${error.text || error.message}\n\nPlease check your EmailJS configuration.`);
            }
        }
        
        function generateWeeklyReport(teacher) {
            // Get tickets awarded in the CURRENT RAFFLE WEEK only
            const weekTickets = auditLog.filter(entry => 
                entry.teacherId === teacher.id &&
                entry.action === 'Awarded Tickets' &&
                entry.week === currentWeek  // Only tickets from current week
            );
            
            console.log('=== WEEKLY REPORT DEBUG ===');
            console.log('Current week:', currentWeek);
            console.log('Generating report for teacher:', teacher.name, 'ID:', teacher.id);
            console.log('Total audit log entries:', auditLog.length);
            console.log('Audit log sample (first 3):', auditLog.slice(0, 3));
            console.log('Week tickets found for this teacher in week', currentWeek, ':', weekTickets.length);
            console.log('Week tickets:', weekTickets);
            console.log('Teacher sections:', teacher.sections);
            
            if (weekTickets.length === 0) {
                console.log('No tickets found - returning early message');
                return `Hi ${teacher.name},\n\nYou haven't awarded any raffle tickets in Week ${currentWeek} yet.\n\nNo Kickboard points to enter.\n\nThank you!`;
            }
            
            // Organize by period/class
            const periodData = {};
            
            weekTickets.forEach(entry => {
                console.log('Processing entry:', entry);
                
                const student = students.find(s => s.id === entry.studentId);
                if (!student) {
                    console.warn('Student not found for ID:', entry.studentId);
                    return;
                }
                
                // Use period info from audit log if available, otherwise try to find it
                let studentPeriod = 'Unknown Period';
                let studentClass = 'Unknown Class';
                
                console.log('Entry period:', entry.period, 'Entry courseName:', entry.courseName);
                
                if (entry.period && entry.courseName) {
                    // Use period info stored in audit log
                    studentPeriod = `Period ${entry.period}`;
                    studentClass = entry.courseName;
                    console.log('Using period info from audit log:', studentPeriod, studentClass);
                } else if (teacher.sections && teacher.sections.length > 0) {
                    // Fallback: search teacher's sections
                    console.log('Searching teacher sections for student:', student.id);
                    for (const section of teacher.sections) {
                        console.log('Checking section:', section.period, section.courseName, 'Students:', section.students?.length);
                        if (section.students && section.students.some(s => s.id === student.id)) {
                            studentPeriod = `Period ${section.period}`;
                            studentClass = section.courseName;
                            console.log('Found in section:', studentPeriod, studentClass);
                            break;
                        }
                    }
                }
                
                const periodKey = `${studentPeriod} - ${studentClass}`;
                console.log('Period key:', periodKey);
                
                // Initialize period data if needed
                if (!periodData[periodKey]) {
                    periodData[periodKey] = {
                        students: {}
                    };
                }
                
                // Initialize student data if needed
                const studentName = entry.studentName;
                if (!periodData[periodKey].students[studentName]) {
                    periodData[periodKey].students[studentName] = {
                        pbis: 0,
                        attendance: 0,
                        academic: 0
                    };
                }
                
                // Add tickets to the appropriate category
                const count = parseInt(entry.ticketCount) || 0;
                console.log('Adding', count, 'tickets of category:', entry.category);
                
                if (entry.category === 'PBIS') {
                    periodData[periodKey].students[studentName].pbis += count;
                } else if (entry.category === 'Attendance') {
                    periodData[periodKey].students[studentName].attendance += count;
                } else if (entry.category === 'Academics') {
                    periodData[periodKey].students[studentName].academic += count;
                }
            });
            
            console.log('Final period data:', periodData);
            console.log('=== END DEBUG ===');
            
            // Build the report
            let report = `Hi ${teacher.name},\n\nHere are the raffle tickets you awarded in Week ${currentWeek}, organized by class:\n\n`;
            report += `${'='.repeat(60)}\n\n`;
            
            let grandTotalTickets = 0;
            let grandTotalKickboard = 0;
            
            // Sort periods for consistent ordering
            const sortedPeriods = Object.keys(periodData).sort();
            
            sortedPeriods.forEach(periodKey => {
                const period = periodData[periodKey];
                
                report += `${periodKey}\n`;
                report += `${'-'.repeat(60)}\n`;
                
                let periodTotalTickets = 0;
                let periodTotalKickboard = 0;
                
                // Sort students alphabetically
                const sortedStudents = Object.keys(period.students).sort();
                
                sortedStudents.forEach(studentName => {
                    const studentTickets = period.students[studentName];
                    const pbis = studentTickets.pbis;
                    const attendance = studentTickets.attendance;
                    const academic = studentTickets.academic;
                    const totalTickets = pbis + attendance + academic;
                    
                    // Skip students with 0 tickets (shouldn't happen, but just in case)
                    if (totalTickets === 0) return;
                    
                    const pbisKickboard = pbis * kickboardSettings.pbisPoints;
                    const attendanceKickboard = attendance * kickboardSettings.attendancePoints;
                    const academicKickboard = academic * kickboardSettings.academicPoints;
                    const totalKickboard = pbisKickboard + attendanceKickboard + academicKickboard;
                    
                    report += `  ${studentName}:\n`;
                    if (pbis > 0) {
                        report += `    • PBIS: ${pbis} ticket(s) → $${pbisKickboard.toLocaleString()}\n`;
                    }
                    if (attendance > 0) {
                        report += `    • Attendance: ${attendance} ticket(s) → $${attendanceKickboard.toLocaleString()}\n`;
                    }
                    if (academic > 0) {
                        report += `    • Academic: ${academic} ticket(s) → $${academicKickboard.toLocaleString()}\n`;
                    }
                    report += `    TOTAL: ${totalTickets} ticket(s) = $${totalKickboard.toLocaleString()} Kickboard\n\n`;
                    
                    periodTotalTickets += totalTickets;
                    periodTotalKickboard += totalKickboard;
                });
                
                report += `${periodKey} TOTAL: ${periodTotalTickets} tickets = $${periodTotalKickboard.toLocaleString()} Kickboard\n`;
                report += `${'='.repeat(60)}\n\n`;
                
                grandTotalTickets += periodTotalTickets;
                grandTotalKickboard += periodTotalKickboard;
            });
            
            report += `GRAND TOTAL: ${grandTotalTickets} raffle tickets = $${grandTotalKickboard.toLocaleString()} Kickboard points\n\n`;
            report += `Please log into Kickboard and award these points to each student.\n\nThank you!\n- Wildcat Rewards System`;
            
            console.log('Report generated:', report);
            
            return report;
        }
        
        function getWeekStartDate() {
            // Get Monday of current week
            const now = new Date();
            const day = now.getDay();
            const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
            return new Date(now.setDate(diff));
        }
        
        async function sendWeeklyReportsNow() {
            if (!emailJSConfig.serviceId || !emailJSConfig.templateId || !emailJSConfig.publicKey) {
                alert('⚠️ Please configure EmailJS settings first');
                return;
            }
            
            if (!confirm('📧 Send weekly reports to all teachers now?\n\nThis will email a Kickboard summary to every teacher with an email address.')) {
                return;
            }
            
            const teachersWithEmail = teachers.filter(t => t.email && t.email.includes('@'));
            
            if (teachersWithEmail.length === 0) {
                alert('⚠️ No teachers have email addresses configured!\n\nPlease add emails to teacher accounts first.');
                return;
            }
            
            let sent = 0;
            let failed = 0;
            
            for (const teacher of teachersWithEmail) {
                try {
                    const report = generateWeeklyReport(teacher);
                    
                    await emailjs.send(
                        emailJSConfig.serviceId,
                        emailJSConfig.templateId,
                        {
                            to_email: teacher.email,
                            to_name: teacher.name,
                            subject: kickboardSettings.emailSubject,
                            week_number: currentWeek,
                            report_content: report
                        },
                        emailJSConfig.publicKey
                    );
                    
                    sent++;
                    console.log(`✅ Sent to ${teacher.name}`);
                } catch (error) {
                    failed++;
                    console.error(`❌ Failed to send to ${teacher.name}:`, error);
                }
            }
            
            alert(`📧 Weekly Reports Sent!\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}\n\nCheck console for details.`);
        }
        
        // Auto-send emails on Friday at 4pm
        function checkWeeklyEmailSchedule() {
            const now = new Date();
            const dayOfWeek = now.getDay(); // 0=Sunday, 5=Friday
            const hour = now.getHours();
            
            // Check if it's Friday at 4pm
            if (dayOfWeek === kickboardSettings.emailDay && hour === kickboardSettings.emailHour) {
                // Check if we already sent today
                const lastSent = localStorage.getItem('lastWeeklyEmailSent');
                const today = now.toDateString();
                
                if (lastSent !== today) {
                    console.log('⏰ Auto-sending weekly reports...');
                    sendWeeklyReportsNow();
                    localStorage.setItem('lastWeeklyEmailSent', today);
                }
            }
        }
        
        // Check every hour for scheduled email send
        setInterval(checkWeeklyEmailSchedule, 60 * 60 * 1000); // Check every hour

        async function saveData() {
            if (isSyncing) {
                await new Promise(resolve => setTimeout(resolve, 100));
                if (isSyncing) return;
            }
            
            isSyncing = true;

            try {
                const dataToSave = {
                    students,
                    currentWeek,
                    cycleDuration,
                    weeklyWinners,
                    bigRaffleWinners,
                    teachers,
                    auditLog,
                    weeklyHistory,
                    pbisSubcategories,
                    academicSubcategories,
                    lastPowerSchoolSync,
                    kickboardSettings,
                    emailJSConfig,
                    hallPasses,
                    passSettings,
                    preventionGroups,
                    schoolBranding,
                    behaviorReferrals,
                    referralIdCounter,
                    detentions,
                    detentionIdCounter,
                    detentionLocations,
                    detentionReasons,
                    loginHistory,
                    // Auto-week system variables
                    autoWeekEnabled,
                    lastAutoResetDate,
                    weekResetDay,
                    weekResetHour,
                    // Jackpot cycle variables
                    currentCycle,
                    cycleHistory,
                    lastSaveTimestamp: Date.now()
                };
                
                // Always save to localStorage as backup
                localStorage.setItem('raffleData', JSON.stringify(dataToSave));
                console.log('✅ Saved to localStorage');

                // Save to Firebase if initialized - SPLIT INTO MULTIPLE DOCUMENTS
                if (firebaseInitialized && firebaseDb) {
                    try {
                        const { doc, setDoc } = window.firebaseModules;
                        const timestamp = Date.now();
                        
                        // Document 1: Core data (students, teachers, settings)
                        const mainDoc = doc(firebaseDb, 'raffle_data', 'main');
                        await setDoc(mainDoc, {
                            students,
                            currentWeek,
                            cycleDuration,
                            teachers,
                            pbisSubcategories,
                            academicSubcategories,
                            lastPowerSchoolSync,
                            kickboardSettings,
                            emailJSConfig,
                            passSettings,
                            schoolBranding,
                            referralIdCounter,
                            // Auto-week system
                            autoWeekEnabled,
                            lastAutoResetDate,
                            weekResetDay,
                            weekResetHour,
                            // Jackpot cycles
                            currentCycle,
                            cycleHistory,
                            lastSaveTimestamp: timestamp
                        });
                        
                        // Small delay between writes
                        await new Promise(resolve => setTimeout(resolve, 200));
                        
                        // Document 2: Everything else (history, logs, passes, referrals)
                        const secondaryDoc = doc(firebaseDb, 'raffle_data', 'secondary');
                        await setDoc(secondaryDoc, {
                            weeklyWinners,
                            bigRaffleWinners,
                            weeklyHistory,
                            auditLog,
                            loginHistory,
                            hallPasses,
                            preventionGroups,
                            behaviorReferrals,
                            detentions,
                            detentionLocations,
                            detentionReasons,
                            lastSaveTimestamp: timestamp
                        });
                        
                        console.log('✅ Saved to Firebase (2 documents)');
                        lastSaveTimestamp = timestamp;
                    } catch (error) {
                        console.error('❌ Firebase save error:', error);
                        // localStorage backup already saved, so data is safe
                    }
                } else {
                    console.log('ℹ️ Firebase not initialized, using localStorage only');
                }
            } catch (error) {
                console.error('Save error:', error);
            } finally {
                isSyncing = false;
                lastUserActivity = Date.now();
            }
        }

        // PowerSchool API Functions
        async function fetchFromPowerSchool(endpoint) {
            try {
                const response = await fetch(POWERSCHOOL_BASE_URL + endpoint, {
                    headers: {
                        'X-API-Key': POWERSCHOOL_API_KEY
                    }
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                return await response.json();
            } catch (error) {
                console.error(`PowerSchool API error (${endpoint}):`, error);
                throw error;
            }
        }

        async function syncFromPowerSchool() {
            if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'superadmin')) {
                alert('Only admins can sync with PowerSchool');
                return;
            }

            const syncButton = document.getElementById('powerSchoolSyncBtn');
            if (syncButton) {
                syncButton.disabled = true;
                syncButton.textContent = '🔄 Syncing...';
            }

            try {
                // Fetch all data from PowerSchool
                const [psStudents, psTeachers, psSections, psEnrollments] = await Promise.all([
                    fetchFromPowerSchool('students.jsp'),
                    fetchFromPowerSchool('teachers.jsp'),
                    fetchFromPowerSchool('sections.jsp'),
                    fetchFromPowerSchool('enrollments.jsp')
                ]);

                // Update students
                psStudents.forEach(psStudent => {
                    let student = students.find(s => s.id === psStudent.id);
                    
                    if (!student) {
                        // New student from PowerSchool
                        students.push({
                            id: psStudent.id,
                            firstName: psStudent.firstName,
                            lastName: psStudent.lastName,
                            grade: psStudent.grade,
                            pbisTickets: 0,
                            attendanceTickets: 0,
                            academicTickets: 0,
                            bigRaffleQualified: false,
                            ticketHistory: []
                        });
                    } else {
                        // Update existing student info
                        student.firstName = psStudent.firstName;
                        student.lastName = psStudent.lastName;
                        student.grade = psStudent.grade;
                    }
                });

                // Build teacher-section mappings
                teachers.forEach(teacher => {
                    // Find matching PowerSchool teacher
                    const psTeacher = psTeachers.find(pt => 
                        pt.firstName.toLowerCase() === teacher.name.split(' ')[0].toLowerCase() ||
                        pt.lastName.toLowerCase() === teacher.name.split(' ').pop().toLowerCase()
                    );

                    if (psTeacher) {
                        teacher.powerSchoolId = psTeacher.id;

                        // Find sections this teacher teaches
                        const teacherSections = psSections.filter(s => s.teacherId === psTeacher.id);

                        teacher.sections = teacherSections.map(section => {
                            // Find students enrolled in this section
                            const sectionEnrollments = psEnrollments.filter(e => e.sectionId === section.sectionId);
                            const studentIds = sectionEnrollments.map(e => e.studentId);

                            return {
                                sectionId: section.sectionId,
                                period: section.period || 'N/A',
                                courseName: section.courseName,
                                students: studentIds
                            };
                        });
                    } else {
                        teacher.sections = [];
                    }
                });

                // Save synced data
                lastPowerSchoolSync = new Date().toISOString();
                await saveData();
                
                updateAllDisplays();
                
                alert(`✅ PowerSchool sync complete!\n\n${psStudents.length} students\n${psTeachers.length} teachers\n${psSections.length} sections\n${psEnrollments.length} enrollments`);

            } catch (error) {
                console.error('PowerSchool sync error:', error);
                alert('❌ PowerSchool sync failed!\n\n' + error.message + '\n\nPlease check:\n- PowerSchool plugin is installed\n- API credentials are correct\n- Network connection is working');
            } finally {
                if (syncButton) {
                    syncButton.disabled = false;
                    syncButton.textContent = '🔄 Sync with PowerSchool Now';
                }
            }
        }

        async function createCloudBin() {
            if (JSONBIN_API_KEY === 'YOUR_API_KEY_HERE') {
                return; // Cloud not configured
            }

            try {
                const response = await fetch('https://api.jsonbin.io/v3/b', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Master-Key': JSONBIN_API_KEY
                    },
                    body: JSON.stringify({
                        students,
                        currentWeek,
                        weeklyWinners,
                        bigRaffleWinners,
                        teachers,
                        auditLog,
                        weeklyHistory,
                        pbisSubcategories,
                        academicSubcategories,
                        lastPowerSchoolSync
                    })
                });

                if (response.ok) {
                    const result = await response.json();
                    binId = result.metadata.id;
                    localStorage.setItem('schoolBinId', binId);
                    
                    console.log('✅ New cloud bin created:', binId);
                    alert(`✅ New cloud storage created!\n\n` +
                          `Your new School ID: ${binId}\n\n` +
                          `Your data has been saved to the cloud.\n` +
                          `All users will now sync to this storage.`);
                    
                    // Save again to make sure it's synced
                    await saveData();
                } else {
                    console.error('Failed to create bin:', response.status);
                    alert('❌ Could not create cloud storage.\n\nPlease check your API key is valid at jsonbin.io');
                }
            } catch (error) {
                console.error('Failed to create cloud bin:', error);
                alert('❌ Error creating cloud storage: ' + error.message);
            }
        }

        // Auto-refresh data from cloud only when inactive
        autoRefreshInterval = setInterval(async () => {
            // Check for auto-week reset first
            checkAndRunAutoWeekReset();
            
            // Only refresh if user has been inactive for 60+ seconds
            const timeSinceActivity = Date.now() - lastUserActivity;
            
            if (binId && !isSyncing && (currentUser || currentStudent) && timeSinceActivity > AUTO_REFRESH_DELAY) {
                await loadData();
                if (currentUser) {
                    updateAllDisplays();
                } else if (currentStudent) {
                    const student = students.find(s => s.id === currentStudent.id);
                    if (student) {
                        currentStudent = student;
                        updateStudentView();
                    }
                }
            }
        }, 30000); // Check every 30 seconds, but only refresh if inactive

        // Analytics Functions
        let gradeChartInstance = null;
        let weekChartInstance = null;
        let qualificationChartInstance = null;

        let currentDataSubtab = 'academy'; // Track current subtab
        let currentDataView = 'charts'; // Track current view (charts or tables)

        function switchDataSubtab(subtab) {
            // Update button states with inline styles
            document.querySelectorAll('.subtab-button').forEach(btn => {
                btn.classList.remove('active');
                btn.style.background = '#f5f5f5';
                btn.style.color = '#333';
                btn.style.boxShadow = 'none';
            });
            
            const activeBtn = document.getElementById(`${subtab}Subtab`);
            activeBtn.classList.add('active');
            
            // Set gradient based on which tab
            if (subtab === 'academy') {
                activeBtn.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
            } else if (subtab === 'middleschool') {
                activeBtn.style.background = 'linear-gradient(135deg, #ff9800 0%, #f57c00 100%)';
            } else if (subtab === 'highschool') {
                activeBtn.style.background = 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)';
            }
            activeBtn.style.color = 'white';
            activeBtn.style.boxShadow = '0 2px 8px rgba(102, 126, 234, 0.3)';
            
            // Update content visibility - remove both 'active' and 'hidden' from all, then add 'active' to selected
            document.querySelectorAll('.data-subtab').forEach(tab => {
                tab.classList.remove('active');
                tab.classList.add('hidden'); // Add hidden to non-active tabs
            });
            
            const selectedTab = document.getElementById(`${subtab}Data`);
            selectedTab.classList.remove('hidden'); // Remove hidden from active tab
            selectedTab.classList.add('active');
            
            currentDataSubtab = subtab;
            
            console.log('Switched to subtab:', subtab, 'Element visible:', !selectedTab.classList.contains('hidden')); // Debug
            
            // Refresh the current view (charts or tables)
            toggleDataView(currentDataView);
        }
        
        // ========================================
        // SETTINGS SUBTAB NAVIGATION
        // ========================================
        
        function switchSettingsSubtab(subtab) {
            // Update button states
            document.querySelectorAll('.settings-subtab-button').forEach(btn => {
                btn.classList.remove('active');
                btn.style.background = '#f5f5f5';
                btn.style.color = '#333';
                btn.style.boxShadow = 'none';
            });
            
            const activeBtn = document.getElementById(`${subtab}SettingsSubtab`);
            if (activeBtn) {
                activeBtn.classList.add('active');
                activeBtn.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                activeBtn.style.color = 'white';
                activeBtn.style.boxShadow = '0 2px 8px rgba(102, 126, 234, 0.3)';
            }
            
            // Hide all settings content sections
            document.querySelectorAll('.settings-subtab-content').forEach(content => {
                content.style.display = 'none';
            });
            
            // Show selected content
            const selectedContent = document.getElementById(`${subtab}SettingsContent`);
            if (selectedContent) {
                selectedContent.style.display = 'block';
            }
            
            console.log('Switched to settings subtab:', subtab);
        }

        function toggleDataView(view) {
            currentDataView = view; // Store current view
            
            const suffix = currentDataSubtab === 'academy' ? 'Academy' : 
                          currentDataSubtab === 'middleschool' ? 'MS' : 'HS';
            
            console.log('toggleDataView:', view, 'suffix:', suffix); // Debug
            
            if (view === 'charts') {
                // Hide all table views
                document.getElementById('tablesViewAcademy')?.classList.add('hidden');
                document.getElementById('tablesViewMS')?.classList.add('hidden');
                document.getElementById('tablesViewHS')?.classList.add('hidden');
                
                // Show appropriate chart view
                const chartElement = document.getElementById(`chartsView${suffix}`);
                console.log('Showing chart element:', `chartsView${suffix}`, chartElement); // Debug
                if (chartElement) {
                    chartElement.classList.remove('hidden');
                }
                
                updateAnalyticsCharts();
            } else {
                // Hide all chart views
                document.getElementById('chartsViewAcademy')?.classList.add('hidden');
                document.getElementById('chartsViewMS')?.classList.add('hidden');
                document.getElementById('chartsViewHS')?.classList.add('hidden');
                
                // Show appropriate table view
                const tableElement = document.getElementById(`tablesView${suffix}`);
                console.log('Showing table element:', `tablesView${suffix}`, tableElement); // Debug
                if (tableElement) {
                    tableElement.classList.remove('hidden');
                }
                
                updateAnalyticsTables();
            }
        }

        // ========================================
        // DATA & ANALYTICS TIME FILTERS
        // ========================================
        
        let currentDataTimeFilter = 'allTime'; // Default to show all data
        let customDataStartDate = null;
        let customDataEndDate = null;
        
        function setDataTimeFilter(filter) {
            currentDataTimeFilter = filter;
            
            // Update button states
            document.querySelectorAll('.time-filter-btn').forEach(btn => {
                btn.style.background = 'rgba(255,255,255,0.2)';
                btn.style.color = 'white';
            });
            
            const activeBtn = document.getElementById('filter' + filter.charAt(0).toUpperCase() + filter.slice(1));
            if (activeBtn) {
                activeBtn.style.background = 'white';
                activeBtn.style.color = '#667eea';
            }
            
            // Hide custom date picker
            document.getElementById('customDateRangePicker').style.display = 'none';
            
            // Update display text
            const filterText = {
                'thisWeek': 'This Week (Current)',
                'last7Days': 'Last 7 Days',
                'last30Days': 'Last 30 Days',
                'thisCycle': `This Cycle (${currentCycle.name || 'Not configured'})`,
                'allTime': 'All Time'
            };
            
            document.getElementById('currentFilterText').textContent = filterText[filter];
            
            // Refresh analytics with new filter
            updateAnalyticsCharts();
            updateAnalyticsTables();
        }
        
        function toggleCustomDateRange() {
            const picker = document.getElementById('customDateRangePicker');
            picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
        }
        
        function applyCustomDateRange() {
            const startDate = document.getElementById('customStartDate').value;
            const endDate = document.getElementById('customEndDate').value;
            
            if (!startDate || !endDate) {
                alert('⚠️ Please select both start and end dates');
                return;
            }
            
            if (new Date(startDate) > new Date(endDate)) {
                alert('⚠️ Start date must be before end date');
                return;
            }
            
            customDataStartDate = startDate;
            customDataEndDate = endDate;
            currentDataTimeFilter = 'custom';
            
            // Update button states
            document.querySelectorAll('.time-filter-btn').forEach(btn => {
                btn.style.background = 'rgba(255,255,255,0.2)';
                btn.style.color = 'white';
            });
            
            document.getElementById('filterCustom').style.background = 'white';
            document.getElementById('filterCustom').style.color = '#667eea';
            
            // Update display text
            document.getElementById('currentFilterText').textContent = 
                `${new Date(startDate).toLocaleDateString()} - ${new Date(endDate).toLocaleDateString()}`;
            
            // Refresh analytics
            updateAnalyticsCharts();
            updateAnalyticsTables();
        }
        
        function getFilteredStudentData() {
            // Return filtered student data based on current time filter
            // This function filters ticket history based on date range
            
            const now = new Date();
            let startDate, endDate;
            
            switch (currentDataTimeFilter) {
                case 'thisWeek':
                    // This week means current week's data (may be 0 if just reset)
                    return students.map(s => ({
                        ...s,
                        pbisTickets: s.pbisTickets || 0,
                        attendanceTickets: s.attendanceTickets || 0,
                        academicTickets: s.academicTickets || 0
                    }));
                    
                case 'last7Days':
                    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    endDate = now;
                    break;
                    
                case 'last30Days':
                    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                    endDate = now;
                    break;
                    
                case 'thisCycle':
                    if (currentCycle.startDate && currentCycle.endDate) {
                        startDate = new Date(currentCycle.startDate);
                        endDate = new Date(currentCycle.endDate);
                    } else {
                        // No cycle configured, show all time
                        return students;
                    }
                    break;
                    
                case 'custom':
                    if (customDataStartDate && customDataEndDate) {
                        startDate = new Date(customDataStartDate);
                        endDate = new Date(customDataEndDate);
                    } else {
                        return students;
                    }
                    break;
                    
                case 'allTime':
                default:
                    // Return all historical data
                    return students.map(s => {
                        // Calculate totals from ticket history
                        const history = s.ticketHistory || [];
                        const pbisTotal = history.filter(h => h.category === 'PBIS').reduce((sum, h) => sum + (h.tickets || 0), 0);
                        const attendanceTotal = history.filter(h => h.category === 'Attendance').reduce((sum, h) => sum + (h.tickets || 0), 0);
                        const academicTotal = history.filter(h => h.category === 'Academic').reduce((sum, h) => sum + (h.tickets || 0), 0);
                        
                        return {
                            ...s,
                            pbisTickets: pbisTotal,
                            attendanceTickets: attendanceTotal,
                            academicTickets: academicTotal
                        };
                    });
            }
            
            // For date range filters, calculate from ticket history
            return students.map(s => {
                const history = s.ticketHistory || [];
                const filteredHistory = history.filter(h => {
                    const ticketDate = new Date(h.timestamp);
                    return ticketDate >= startDate && ticketDate <= endDate;
                });
                
                const pbisTotal = filteredHistory.filter(h => h.category === 'PBIS').reduce((sum, h) => sum + (h.tickets || 0), 0);
                const attendanceTotal = filteredHistory.filter(h => h.category === 'Attendance').reduce((sum, h) => sum + (h.tickets || 0), 0);
                const academicTotal = filteredHistory.filter(h => h.category === 'Academic').reduce((sum, h) => sum + (h.tickets || 0), 0);
                
                return {
                    ...s,
                    pbisTickets: pbisTotal,
                    attendanceTickets: attendanceTotal,
                    academicTickets: academicTotal
                };
            });
        }
        
        function updateAnalyticsCharts() {
            const suffix = currentDataSubtab === 'academy' ? 'Academy' : 
                          currentDataSubtab === 'middleschool' ? 'MS' : 'HS';
            
            updateMetricCards(suffix); // NEW: Update metric cards
            updateGradeChart(suffix);
            updateWeekChart(suffix);
            updateQualificationChart(suffix);
        }
        
        // NEW FUNCTION: Update metric cards for Data & Analytics
        function updateMetricCards(suffix) {
            // Get filtered student data based on current time filter
            let filteredStudents = getFilteredStudentData();
            
            // Further filter by school level (MS/HS) if needed
            if (suffix === 'MS') {
                filteredStudents = filteredStudents.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 6 && grade <= 8;
                });
            } else if (suffix === 'HS') {
                filteredStudents = filteredStudents.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 9 && grade <= 12;
                });
            }
            
            // Calculate totals
            let totalTickets = 0;
            let pbisTickets = 0;
            let attendanceTickets = 0;
            let academicTickets = 0;
            let qualifiedCount = 0;
            
            filteredStudents.forEach(s => {
                const pbis = s.pbisTickets || 0;
                const attendance = s.attendanceTickets || 0;
                const academic = s.academicTickets || 0;
                
                pbisTickets += pbis;
                attendanceTickets += attendance;
                academicTickets += academic;
                totalTickets += pbis + attendance + academic;
                
                // Count qualified students (has tickets in all 3 categories)
                if (pbis > 0 && attendance > 0 && academic > 0) {
                    qualifiedCount++;
                }
            });
            
            // Calculate metrics
            const totalStudents = filteredStudents.length;
            const qualificationRate = totalStudents > 0 ? Math.round((qualifiedCount / totalStudents) * 100) : 0;
            const avgTickets = totalStudents > 0 ? (totalTickets / totalStudents).toFixed(1) : '0.0';
            
            // Determine prefix for element IDs
            const prefix = suffix === 'Academy' ? 'academy' : 
                          suffix === 'MS' ? 'ms' : 'hs';
            
            // Update metric cards
            const totalTicketsEl = document.getElementById(`${prefix}TotalTickets`);
            const qualifiedEl = document.getElementById(`${prefix}QualifiedStudents`);
            const qualificationRateEl = document.getElementById(`${prefix}QualificationRate`);
            const avgTicketsEl = document.getElementById(`${prefix}AvgTickets`);
            
            if (totalTicketsEl) totalTicketsEl.textContent = totalTickets;
            if (qualifiedEl) qualifiedEl.textContent = qualifiedCount;
            if (qualificationRateEl) qualificationRateEl.textContent = qualificationRate + '%';
            if (avgTicketsEl) avgTicketsEl.textContent = avgTickets;
            
            // Update category breakdown cards
            const pbisEl = document.getElementById(`${prefix}PbisTickets`);
            const attendanceEl = document.getElementById(`${prefix}AttendanceTickets`);
            const academicEl = document.getElementById(`${prefix}AcademicTickets`);
            
            if (pbisEl) pbisEl.textContent = pbisTickets;
            if (attendanceEl) attendanceEl.textContent = attendanceTickets;
            if (academicEl) academicEl.textContent = academicTickets;
        }

        function updateGradeChart(suffix) {
            const elementId = `gradeChart${suffix}`;
            const ctx = document.getElementById(elementId);
            console.log('updateGradeChart called with suffix:', suffix, 'Element:', elementId, 'Found:', ctx); // Debug
            
            if (!ctx) {
                console.error('Chart element not found:', elementId);
                return;
            }

            // Filter students based on subtab
            let filteredStudents = students;
            if (suffix === 'MS') {
                filteredStudents = students.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 6 && grade <= 8;
                });
            } else if (suffix === 'HS') {
                filteredStudents = students.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 9 && grade <= 12;
                });
            }

            console.log('Filtered students:', filteredStudents.length); // Debug

            // Calculate tickets by grade
            const gradeData = {};
            const gradeRange = suffix === 'MS' ? [6, 7, 8] : 
                              suffix === 'HS' ? [9, 10, 11, 12] : 
                              [6, 7, 8, 9, 10, 11, 12];
            
            gradeRange.forEach(grade => {
                gradeData[grade] = { pbis: 0, attendance: 0, academic: 0 };
            });

            filteredStudents.forEach(s => {
                const grade = parseInt(s.grade);
                if (gradeData[grade]) {
                    gradeData[grade].pbis += s.pbisTickets || 0;
                    gradeData[grade].attendance += s.attendanceTickets || 0;
                    gradeData[grade].academic += s.academicTickets || 0;
                }
            });

            const grades = Object.keys(gradeData).map(g => `Grade ${g}`);
            const pbisData = Object.values(gradeData).map(d => d.pbis);
            const attendanceData = Object.values(gradeData).map(d => d.attendance);
            const academicData = Object.values(gradeData).map(d => d.academic);

            // Destroy existing chart
            const chartInstanceName = `gradeChartInstance${suffix}`;
            if (window[chartInstanceName]) {
                window[chartInstanceName].destroy();
            }

            // Create new chart
            window[chartInstanceName] = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: grades,
                    datasets: [
                        {
                            label: 'PBIS',
                            data: pbisData,
                            backgroundColor: 'rgba(102, 126, 234, 0.8)'
                        },
                        {
                            label: 'Attendance',
                            data: attendanceData,
                            backgroundColor: 'rgba(40, 167, 69, 0.8)'
                        },
                        {
                            label: 'Academic',
                            data: academicData,
                            backgroundColor: 'rgba(255, 193, 7, 0.8)'
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Number of Tickets'
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top'
                        }
                    }
                }
            });
        }

        function updateWeekChart(suffix) {
            const ctx = document.getElementById(`weekChart${suffix}`);
            if (!ctx) return;

            // Filter students based on suffix
            let filteredStudents = students;
            if (suffix === 'MS') {
                filteredStudents = students.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 6 && grade <= 8;
                });
            } else if (suffix === 'HS') {
                filteredStudents = students.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 9 && grade <= 12;
                });
            }

            // Use actual historical data (Note: weeklyHistory doesn't split by MS/HS, so Academy view is most accurate)
            const weekData = {};
            for (let week = 1; week <= 5; week++) {
                weekData[week] = { pbis: 0, attendance: 0, academic: 0 };
            }

            // For current week, calculate from filtered students
            if (currentWeek >= 1 && currentWeek <= 5) {
                weekData[currentWeek].pbis = filteredStudents.reduce((sum, s) => sum + (s.pbisTickets || 0), 0);
                weekData[currentWeek].attendance = filteredStudents.reduce((sum, s) => sum + (s.attendanceTickets || 0), 0);
                weekData[currentWeek].academic = filteredStudents.reduce((sum, s) => sum + (s.academicTickets || 0), 0);
            }

            // For Academy-wide, include historical data
            if (suffix === 'Academy') {
                weeklyHistory.forEach(h => {
                    if (h.week >= 1 && h.week <= 5 && h.week !== currentWeek) {
                        weekData[h.week].pbis = h.pbisTickets || 0;
                        weekData[h.week].attendance = h.attendanceTickets || 0;
                        weekData[h.week].academic = h.academicTickets || 0;
                    }
                });
            }

            const weeks = Object.keys(weekData).map(w => `Week ${w}`);
            const pbisData = Object.values(weekData).map(d => d.pbis);
            const attendanceData = Object.values(weekData).map(d => d.attendance);
            const academicData = Object.values(weekData).map(d => d.academic);

            // Destroy existing chart
            const chartInstanceName = `weekChartInstance${suffix}`;
            if (window[chartInstanceName]) {
                window[chartInstanceName].destroy();
            }

            // Create new chart
            window[chartInstanceName] = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: weeks,
                    datasets: [
                        {
                            label: 'PBIS',
                            data: pbisData,
                            borderColor: 'rgba(102, 126, 234, 1)',
                            backgroundColor: 'rgba(102, 126, 234, 0.1)',
                            tension: 0.4
                        },
                        {
                            label: 'Attendance',
                            data: attendanceData,
                            borderColor: 'rgba(40, 167, 69, 1)',
                            backgroundColor: 'rgba(40, 167, 69, 0.1)',
                            tension: 0.4
                        },
                        {
                            label: 'Academic',
                            data: academicData,
                            borderColor: 'rgba(255, 193, 7, 1)',
                            backgroundColor: 'rgba(255, 193, 7, 0.1)',
                            tension: 0.4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Tickets Awarded'
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top'
                        }
                    }
                }
            });
        }

        function updateQualificationChart(suffix) {
            const ctx = document.getElementById(`qualificationChart${suffix}`);
            if (!ctx) return;

            // Filter students based on suffix
            let filteredStudents = students;
            if (suffix === 'MS') {
                filteredStudents = students.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 6 && grade <= 8;
                });
            } else if (suffix === 'HS') {
                filteredStudents = students.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 9 && grade <= 12;
                });
            }

            const totalStudents = filteredStudents.length;
            const qualifiedStudents = filteredStudents.filter(s => s.bigRaffleQualified).length;
            const notQualified = totalStudents - qualifiedStudents;

            // Destroy existing chart
            const chartInstanceName = `qualificationChartInstance${suffix}`;
            if (window[chartInstanceName]) {
                window[chartInstanceName].destroy();
            }

            // Create new chart
            window[chartInstanceName] = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: ['Qualified', 'Not Qualified'],
                    datasets: [{
                        data: [qualifiedStudents, notQualified],
                        backgroundColor: [
                            'rgba(40, 167, 69, 0.8)',
                            'rgba(220, 53, 69, 0.8)'
                        ]
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: {
                        legend: {
                            display: true,
                            position: 'bottom'
                        },
                        title: {
                            display: true,
                            text: `${qualifiedStudents} of ${totalStudents} students qualified (${totalStudents > 0 ? Math.round(qualifiedStudents/totalStudents*100) : 0}%)`
                        }
                    }
                }
            });
        }

        function updateAnalyticsTables() {
            const suffix = currentDataSubtab === 'academy' ? 'Academy' : 
                          currentDataSubtab === 'middleschool' ? 'MS' : 'HS';
            
            updateGradeDataTable(suffix);
            updateWeeklyDataTable(suffix);
        }

        function updateGradeDataTable(suffix) {
            const tbody = document.getElementById(`gradeDataTable${suffix}`);
            if (!tbody) return;

            // Filter students based on suffix
            let filteredStudents = students;
            const gradeRange = suffix === 'MS' ? [6, 7, 8] : 
                              suffix === 'HS' ? [9, 10, 11, 12] : 
                              [6, 7, 8, 9, 10, 11, 12];
            
            if (suffix === 'MS') {
                filteredStudents = students.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 6 && grade <= 8;
                });
            } else if (suffix === 'HS') {
                filteredStudents = students.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 9 && grade <= 12;
                });
            }

            const gradeData = {};
            gradeRange.forEach(grade => {
                gradeData[grade] = { 
                    pbis: 0, 
                    attendance: 0, 
                    academic: 0,
                    count: 0
                };
            });

            filteredStudents.forEach(s => {
                const grade = parseInt(s.grade);
                if (gradeData[grade]) {
                    gradeData[grade].pbis += s.pbisTickets || 0;
                    gradeData[grade].attendance += s.attendanceTickets || 0;
                    gradeData[grade].academic += s.academicTickets || 0;
                    gradeData[grade].count++;
                }
            });

            tbody.innerHTML = Object.entries(gradeData).map(([grade, data]) => {
                const total = data.pbis + data.attendance + data.academic;
                const avg = data.count > 0 ? (total / data.count).toFixed(1) : 0;
                return `
                    <tr>
                        <td>Grade ${grade}</td>
                        <td>${data.pbis}</td>
                        <td>${data.attendance}</td>
                        <td>${data.academic}</td>
                        <td>${total}</td>
                        <td>${data.count}</td>
                        <td>${avg}</td>
                    </tr>
                `;
            }).join('');
        }

        function updateWeeklyDataTable(suffix) {
            const tbody = document.getElementById(`weeklyDataTable${suffix}`);
            if (!tbody) return;

            // Filter students based on suffix
            let filteredStudents = students;
            if (suffix === 'MS') {
                filteredStudents = students.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 6 && grade <= 8;
                });
            } else if (suffix === 'HS') {
                filteredStudents = students.filter(s => {
                    const grade = parseInt(s.grade);
                    return grade >= 9 && grade <= 12;
                });
            }

            const weekData = [];
            
            // For Academy view, add historical weeks
            if (suffix === 'Academy') {
                weeklyHistory.forEach(h => {
                    weekData.push({
                        week: h.week,
                        pbis: h.pbisTickets || 0,
                        attendance: h.attendanceTickets || 0,
                        academic: h.academicTickets || 0,
                        qualified: h.studentsQualified || 0,
                        rate: students.length > 0 ? Math.round((h.studentsQualified || 0) / students.length * 100) : 0
                    });
                });
            }

            // Add current week data
            if (!weeklyHistory.find(h => h.week === currentWeek) || suffix !== 'Academy') {
                const currentPbis = filteredStudents.reduce((sum, s) => sum + (s.pbisTickets || 0), 0);
                const currentAttendance = filteredStudents.reduce((sum, s) => sum + (s.attendanceTickets || 0), 0);
                const currentAcademic = filteredStudents.reduce((sum, s) => sum + (s.academicTickets || 0), 0);
                const currentQualified = filteredStudents.filter(s => 
                    s.pbisTickets > 0 && s.attendanceTickets > 0 && s.academicTickets > 0
                ).length;

                weekData.push({
                    week: currentWeek,
                    pbis: currentPbis,
                    attendance: currentAttendance,
                    academic: currentAcademic,
                    qualified: currentQualified,
                    rate: filteredStudents.length > 0 ? Math.round(currentQualified / filteredStudents.length * 100) : 0
                });
            }

            // Sort by week
            weekData.sort((a, b) => a.week - b.week);

            if (weekData.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: #999;">No data available yet</td></tr>';
            } else {
                tbody.innerHTML = weekData.map(w => `
                    <tr>
                        <td>Week ${w.week}${w.week === currentWeek ? ' (Current)' : ''}</td>
                        <td>${w.pbis}</td>
                        <td>${w.attendance}</td>
                        <td>${w.academic}</td>
                        <td>${w.qualified}</td>
                        <td>${w.rate}%</td>
                    </tr>
                `).join('');
            }
        }

        function updateProgramDataTable() {
            const tbody = document.getElementById('programDataTable');
            if (!tbody) return;

            const currentQualified = students.filter(s => s.bigRaffleQualified).length;
            const currentTotal = students.length;
            const currentRate = currentTotal > 0 ? Math.round(currentQualified/currentTotal*100) : 0;

            // Placeholder for previous cycle data - would be stored in database
            const prevQualified = 0;
            const prevTotal = 0;
            const prevRate = 0;

            tbody.innerHTML = `
                <tr>
                    <td>Total Students</td>
                    <td>${currentTotal}</td>
                    <td>${prevTotal}</td>
                    <td>${currentTotal - prevTotal > 0 ? '+' : ''}${currentTotal - prevTotal}</td>
                </tr>
                <tr>
                    <td>Qualified for Wildcat Jackpot</td>
                    <td>${currentQualified}</td>
                    <td>${prevQualified}</td>
                    <td>${currentQualified - prevQualified > 0 ? '+' : ''}${currentQualified - prevQualified}</td>
                </tr>
                <tr>
                    <td>Qualification Rate</td>
                    <td>${currentRate}%</td>
                    <td>${prevRate}%</td>
                    <td>${currentRate - prevRate > 0 ? '+' : ''}${currentRate - prevRate}%</td>
                </tr>
            `;
        }

        function exportAnalyticsData() {
            // Create workbook
            const wb = XLSX.utils.book_new();

            // Grade Level Data
            const gradeData = [];
            gradeData.push(['Grade', 'PBIS Tickets', 'Attendance Tickets', 'Academic Tickets', 'Total Tickets', 'Students', 'Avg per Student']);
            
            const gradeStats = {};
            for (let grade = 6; grade <= 12; grade++) {
                gradeStats[grade] = { pbis: 0, attendance: 0, academic: 0, count: 0 };
            }

            students.forEach(s => {
                const grade = parseInt(s.grade);
                if (grade >= 6 && grade <= 12) {
                    gradeStats[grade].pbis += s.pbisTickets || 0;
                    gradeStats[grade].attendance += s.attendanceTickets || 0;
                    gradeStats[grade].academic += s.academicTickets || 0;
                    gradeStats[grade].count++;
                }
            });

            Object.entries(gradeStats).forEach(([grade, data]) => {
                const total = data.pbis + data.attendance + data.academic;
                const avg = data.count > 0 ? (total / data.count).toFixed(1) : 0;
                gradeData.push([
                    `Grade ${grade}`,
                    data.pbis,
                    data.attendance,
                    data.academic,
                    total,
                    data.count,
                    avg
                ]);
            });

            const ws1 = XLSX.utils.aoa_to_sheet(gradeData);
            XLSX.utils.book_append_sheet(wb, ws1, 'By Grade');

            // Qualified Students
            const qualifiedData = [];
            qualifiedData.push(['Student ID', 'Name', 'Grade', 'Weeks Qualified', 'Raffle Entries']);
            
            students.filter(s => s.bigRaffleQualified).forEach(s => {
                qualifiedData.push([
                    s.id,
                    `${s.firstName} ${s.lastName}`,
                    s.grade,
                    s.weeksQualified,
                    s.weeksQualified
                ]);
            });

            const ws2 = XLSX.utils.aoa_to_sheet(qualifiedData);
            XLSX.utils.book_append_sheet(wb, ws2, 'Qualified Students');

            // Summary Stats
            const summaryData = [];
            summaryData.push(['Metric', 'Value']);
            summaryData.push(['Total Students', students.length]);
            summaryData.push(['Qualified for Wildcat Jackpot', students.filter(s => s.bigRaffleQualified).length]);
            summaryData.push(['Current Week', currentWeek]);
            summaryData.push(['Total PBIS Tickets', students.reduce((sum, s) => sum + (s.pbisTickets || 0), 0)]);
            summaryData.push(['Total Attendance Tickets', students.reduce((sum, s) => sum + (s.attendanceTickets || 0), 0)]);
            summaryData.push(['Total Academic Tickets', students.reduce((sum, s) => sum + (s.academicTickets || 0), 0)]);

            const ws3 = XLSX.utils.aoa_to_sheet(summaryData);
            XLSX.utils.book_append_sheet(wb, ws3, 'Summary');

            // Export
            XLSX.writeFile(wb, `Raffle_Analytics_${new Date().toISOString().split('T')[0]}.xlsx`);
        }

        // My Activity Functions
        function updateMyActivity() {
            if (!currentUser) return;

            const myLogs = auditLog.filter(log => log.teacherId === currentUser.id && log.action === 'Awarded Tickets');
            
            // Update stats
            const totalTickets = myLogs.reduce((sum, log) => sum + (log.ticketCount || 0), 0);
            const uniqueStudents = [...new Set(myLogs.map(log => log.studentId))].length;
            
            // Count this week's tickets
            const thisWeekLogs = myLogs.filter(log => {
                // Simple approximation - in production would track week in log
                return true; // For now, show all
            });
            const thisWeekTickets = thisWeekLogs.reduce((sum, log) => sum + (log.ticketCount || 0), 0);

            document.getElementById('myTotalTickets').textContent = totalTickets;
            document.getElementById('myStudentsAwarded').textContent = uniqueStudents;
            document.getElementById('myThisWeek').textContent = thisWeekTickets;

            // Update table
            const tbody = document.getElementById('myActivityTable');
            if (myLogs.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="5" style="text-align: center; padding: 60px 20px; color: #999; font-size: 15px; border: none;">
                            <div style="font-size: 48px; margin-bottom: 10px;">📝</div>
                            <div style="font-weight: 500; color: #666; margin-bottom: 5px;">No tickets awarded yet</div>
                            <div style="font-size: 13px; color: #999;">Start awarding tickets to see your activity here!</div>
                        </td>
                    </tr>
                `;
                return;
            }

            tbody.innerHTML = [...myLogs].reverse().map((log, index) => {
                const date = new Date(log.timestamp);
                const formattedDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                const formattedTime = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                
                // Alternate row colors
                const rowBg = index % 2 === 0 ? '#ffffff' : '#f9fafb';
                
                // Category colors and icons
                const categoryStyles = {
                    'PBIS Behaviors': { color: '#667eea', icon: '🎯', bg: '#e0e7ff' },
                    'Perfect Attendance': { color: '#10b981', icon: '📅', bg: '#d1fae5' },
                    'Academics': { color: '#f59e0b', icon: '📚', bg: '#fef3c7' }
                };
                
                const categoryStyle = categoryStyles[log.category] || { color: '#6b7280', icon: '📂', bg: '#f3f4f6' };
                
                return `
                    <tr style="background: ${rowBg}; transition: all 0.2s; border-bottom: 1px solid #f0f0f0;" 
                        onmouseover="this.style.background='#f0f4ff'; this.style.transform='scale(1.005)'" 
                        onmouseout="this.style.background='${rowBg}'; this.style.transform='scale(1)'">
                        <td style="padding: 16px 20px; border: none;">
                            <div style="font-weight: 600; color: #333; font-size: 14px;">${formattedDate}</div>
                            <div style="font-size: 12px; color: #999; margin-top: 2px;">${formattedTime}</div>
                        </td>
                        <td style="padding: 16px 20px; border: none;">
                            <div style="font-weight: 600; color: #667eea; font-size: 14px;">${log.studentName}</div>
                        </td>
                        <td style="padding: 16px 20px; border: none;">
                            <span style="background: ${categoryStyle.bg}; color: ${categoryStyle.color}; padding: 6px 12px; border-radius: 20px; font-weight: 600; font-size: 13px; display: inline-block;">
                                ${categoryStyle.icon} ${log.category}
                            </span>
                        </td>
                        <td style="padding: 16px 20px; text-align: center; border: none;">
                            <span style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 6px 14px; border-radius: 20px; font-weight: 700; font-size: 14px; display: inline-block; min-width: 45px;">
                                ${log.ticketCount} 🎫
                            </span>
                        </td>
                        <td style="padding: 16px 20px; border: none;">
                            <div style="color: #666; font-size: 14px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${log.reason || 'No reason provided'}">
                                ${log.reason || '<span style="color: #ccc; font-style: italic;">No reason</span>'}
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function searchMyActivity() {
            const search = document.getElementById('searchMyActivity').value.toLowerCase();
            const rows = document.querySelectorAll('#myActivityTable tr');
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(search) ? '' : 'none';
            });
        }

        // Leaderboard Functions
        // Subcategory Management Functions
        function updateSubcategoryDropdown() {
            const category = document.getElementById('categorySelect').value;
            const subcategorySelect = document.getElementById('subcategorySelect');
            const subcategoryField = document.getElementById('subcategoryField');
            
            // Clear current options
            subcategorySelect.innerHTML = '<option value="">Select subcategory...</option>';
            
            if (category === 'pbis') {
                // Show subcategory field and populate with PBIS options
                subcategoryField.style.display = 'block';
                pbisSubcategories.forEach(sub => {
                    const option = document.createElement('option');
                    option.value = sub;
                    option.textContent = sub;
                    subcategorySelect.appendChild(option);
                });
            } else if (category === 'academics') {
                // Show subcategory field and populate with Academic options
                subcategoryField.style.display = 'block';
                academicSubcategories.forEach(sub => {
                    const option = document.createElement('option');
                    option.value = sub;
                    option.textContent = sub;
                    subcategorySelect.appendChild(option);
                });
            } else {
                // Hide subcategory field for Attendance
                subcategoryField.style.display = 'none';
            }
        }
        
        function updateCategoryDropdown() {
            const categorySelect = document.getElementById('categorySelect');
            if (!categorySelect) return;
            
            // Check if user is admin or superadmin
            const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'superadmin');
            
            if (isAdmin) {
                // Admin/Superadmin - show all categories
                categorySelect.innerHTML = `
                    <option value="pbis">PBIS Behaviors</option>
                    <option value="attendance">Perfect Attendance</option>
                    <option value="academics">Academics</option>
                `;
            } else {
                // Teacher - hide attendance option
                categorySelect.innerHTML = `
                    <option value="pbis">PBIS Behaviors</option>
                    <option value="academics">Academics</option>
                `;
            }
            
            // Update subcategory dropdown after changing categories
            updateSubcategoryDropdown();
        }

        function updateSubcategoryLists() {
            // Update PBIS subcategories list
            const pbisContainer = document.getElementById('pbisSubcategoriesList');
            if (pbisContainer) {
                pbisContainer.innerHTML = pbisSubcategories.map((sub, index) => `
                    <div style="display: flex; align-items: center; padding: 10px; background: white; border-radius: 4px; margin-bottom: 8px;">
                        <span style="flex: 1; font-weight: 500;">${sub}</span>
                        <button class="btn btn-danger" style="padding: 6px 12px; font-size: 14px;" onclick="removePbisSubcategory(${index})">Remove</button>
                    </div>
                `).join('');
            }

            // Update Academic subcategories list
            const academicContainer = document.getElementById('academicSubcategoriesList');
            if (academicContainer) {
                academicContainer.innerHTML = academicSubcategories.map((sub, index) => `
                    <div style="display: flex; align-items: center; padding: 10px; background: white; border-radius: 4px; margin-bottom: 8px;">
                        <span style="flex: 1; font-weight: 500;">${sub}</span>
                        <button class="btn btn-danger" style="padding: 6px 12px; font-size: 14px;" onclick="removeAcademicSubcategory(${index})">Remove</button>
                    </div>
                `).join('');
            }

            // Update the dropdown if currently on PBIS or Academics
            updateSubcategoryDropdown();
        }

        function addPbisSubcategory() {
            const input = document.getElementById('newPbisSubcategory');
            const newSub = input.value.trim();
            
            if (!newSub) {
                alert('Please enter a subcategory name');
                return;
            }

            if (pbisSubcategories.includes(newSub)) {
                alert('This subcategory already exists');
                return;
            }

            pbisSubcategories.push(newSub);
            input.value = '';
            saveData();
            updateSubcategoryLists();
            alert(`Added "${newSub}" to PBIS subcategories`);
        }

        function removePbisSubcategory(index) {
            const sub = pbisSubcategories[index];
            if (confirm(`Remove "${sub}" from PBIS subcategories?`)) {
                pbisSubcategories.splice(index, 1);
                saveData();
                updateSubcategoryLists();
            }
        }

        function addAcademicSubcategory() {
            const input = document.getElementById('newAcademicSubcategory');
            const newSub = input.value.trim();
            
            if (!newSub) {
                alert('Please enter a subcategory name');
                return;
            }

            if (academicSubcategories.includes(newSub)) {
                alert('This subcategory already exists');
                return;
            }

            academicSubcategories.push(newSub);
            input.value = '';
            saveData();
            updateSubcategoryLists();
            alert(`Added "${newSub}" to Academic subcategories`);
        }

        function removeAcademicSubcategory(index) {
            const sub = academicSubcategories[index];
            if (confirm(`Remove "${sub}" from Academic subcategories?`)) {
                academicSubcategories.splice(index, 1);
                saveData();
                updateSubcategoryLists();
            }
        }

        function updateLeaderboard() {
            document.getElementById('leaderboardWeek').textContent = currentWeek;

            // Split students by grade level
            const msStudents = students.filter(s => {
                const grade = parseInt(s.grade);
                return grade >= 6 && grade <= 8;
            });
            
            const hsStudents = students.filter(s => {
                const grade = parseInt(s.grade);
                return grade >= 9 && grade <= 12;
            });

            // MIDDLE SCHOOL LEADERBOARDS
            // Calculate overall leader (total of all tickets)
            const msOverallTop = [...msStudents]
                .map(s => ({
                    ...s,
                    totalTickets: (s.pbisTickets || 0) + (s.attendanceTickets || 0) + (s.academicTickets || 0)
                }))
                .filter(s => s.totalTickets > 0)
                .sort((a, b) => b.totalTickets - a.totalTickets)
                .slice(0, 10);
            
            // Update MS Overall leaderboard
            const msOverallTable = document.getElementById('overallLeaderboardMS');
            if (msOverallTop.length === 0) {
                msOverallTable.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 20px; color: #999;">No tickets awarded yet</td></tr>';
            } else {
                msOverallTable.innerHTML = msOverallTop.map((s, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                    return `
                        <tr>
                            <td style="padding: 8px; font-size: 16px;">${medal}</td>
                            <td style="padding: 8px; font-weight: 600;">${s.firstName} ${s.lastName}</td>
                            <td style="padding: 8px; text-align: right; font-weight: bold; color: #ff9800; font-size: 16px;">${s.totalTickets} 🎫</td>
                        </tr>
                    `;
                }).join('');
            }
            
            // Get top student for each category (simplified view)
            const msPbisTop = [...msStudents]
                .filter(s => (s.pbisTickets || 0) > 0)
                .sort((a, b) => (b.pbisTickets || 0) - (a.pbisTickets || 0));
            
            const msAttendanceTop = [...msStudents]
                .filter(s => (s.attendanceTickets || 0) > 0)
                .sort((a, b) => (b.attendanceTickets || 0) - (a.attendanceTickets || 0));
            
            const msAcademicTop = [...msStudents]
                .filter(s => (s.academicTickets || 0) > 0)
                .sort((a, b) => (b.academicTickets || 0) - (a.academicTickets || 0));

            // Update MS category leaders (simplified cards)
            const msPbisLeader = document.getElementById('pbisLeaderMS');
            if (msPbisTop.length === 0) {
                msPbisLeader.innerHTML = '<span style="color: #999; font-style: italic;">No tickets yet</span>';
            } else {
                const top = msPbisTop[0];
                msPbisLeader.innerHTML = `<strong>${top.firstName} ${top.lastName}</strong> - ${top.pbisTickets} 🎫`;
            }
            
            const msAttendanceLeader = document.getElementById('attendanceLeaderMS');
            if (msAttendanceTop.length === 0) {
                msAttendanceLeader.innerHTML = '<span style="color: #999; font-style: italic;">No tickets yet</span>';
            } else {
                const top = msAttendanceTop[0];
                msAttendanceLeader.innerHTML = `<strong>${top.firstName} ${top.lastName}</strong> - ${top.attendanceTickets} 🎫`;
            }
            
            const msAcademicLeader = document.getElementById('academicLeaderMS');
            if (msAcademicTop.length === 0) {
                msAcademicLeader.innerHTML = '<span style="color: #999; font-style: italic;">No tickets yet</span>';
            } else {
                const top = msAcademicTop[0];
                msAcademicLeader.innerHTML = `<strong>${top.firstName} ${top.lastName}</strong> - ${top.academicTickets} 🎫`;
            }

            // HIGH SCHOOL LEADERBOARDS
            // Calculate overall leader (total of all tickets)
            const hsOverallTop = [...hsStudents]
                .map(s => ({
                    ...s,
                    totalTickets: (s.pbisTickets || 0) + (s.attendanceTickets || 0) + (s.academicTickets || 0)
                }))
                .filter(s => s.totalTickets > 0)
                .sort((a, b) => b.totalTickets - a.totalTickets)
                .slice(0, 10);
            
            // Update HS Overall leaderboard
            const hsOverallTable = document.getElementById('overallLeaderboardHS');
            if (hsOverallTop.length === 0) {
                hsOverallTable.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 20px; color: #999;">No tickets awarded yet</td></tr>';
            } else {
                hsOverallTable.innerHTML = hsOverallTop.map((s, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                    return `
                        <tr>
                            <td style="padding: 8px; font-size: 16px;">${medal}</td>
                            <td style="padding: 8px; font-weight: 600;">${s.firstName} ${s.lastName}</td>
                            <td style="padding: 8px; text-align: right; font-weight: bold; color: #3b82f6; font-size: 16px;">${s.totalTickets} 🎫</td>
                        </tr>
                    `;
                }).join('');
            }
            
            // Get top student for each category
            const hsPbisTop = [...hsStudents]
                .filter(s => (s.pbisTickets || 0) > 0)
                .sort((a, b) => (b.pbisTickets || 0) - (a.pbisTickets || 0));

            const hsAttendanceTop = [...hsStudents]
                .filter(s => (s.attendanceTickets || 0) > 0)
                .sort((a, b) => (b.attendanceTickets || 0) - (a.attendanceTickets || 0));

            const hsAcademicTop = [...hsStudents]
                .filter(s => (s.academicTickets || 0) > 0)
                .sort((a, b) => (b.academicTickets || 0) - (a.academicTickets || 0));

            // Update HS category leaders (simplified cards)
            const hsPbisLeader = document.getElementById('pbisLeaderHS');
            if (hsPbisTop.length === 0) {
                hsPbisLeader.innerHTML = '<span style="color: #999; font-style: italic;">No tickets yet</span>';
            } else {
                const top = hsPbisTop[0];
                hsPbisLeader.innerHTML = `<strong>${top.firstName} ${top.lastName}</strong> - ${top.pbisTickets} 🎫`;
            }
            
            const hsAttendanceLeader = document.getElementById('attendanceLeaderHS');
            if (hsAttendanceTop.length === 0) {
                hsAttendanceLeader.innerHTML = '<span style="color: #999; font-style: italic;">No tickets yet</span>';
            } else {
                const top = hsAttendanceTop[0];
                hsAttendanceLeader.innerHTML = `<strong>${top.firstName} ${top.lastName}</strong> - ${top.attendanceTickets} 🎫`;
            }
            
            const hsAcademicLeader = document.getElementById('academicLeaderHS');
            if (hsAcademicTop.length === 0) {
                hsAcademicLeader.innerHTML = '<span style="color: #999; font-style: italic;">No tickets yet</span>';
            } else {
                const top = hsAcademicTop[0];
                hsAcademicLeader.innerHTML = `<strong>${top.firstName} ${top.lastName}</strong> - ${top.academicTickets} 🎫`;
            }
        }

        // Authentication functions
        function showCreateAdmin() {
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('createAdminScreen').classList.remove('hidden');
        }

        function backToLogin() {
            document.getElementById('createAdminScreen').classList.add('hidden');
            document.getElementById('connectSchoolScreen').classList.add('hidden');
            document.getElementById('loginScreen').classList.remove('hidden');
            document.getElementById('adminError').textContent = '';
            document.getElementById('connectError').textContent = '';
        }

        function showConnectSchool() {
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('connectSchoolScreen').classList.remove('hidden');
        }

        async function connectToSchool() {
            const schoolId = document.getElementById('schoolIdInput').value.trim();
            const errorDiv = document.getElementById('connectError');

            if (!schoolId) {
                errorDiv.textContent = 'Please enter a School ID';
                return;
            }

            if (JSONBIN_API_KEY === 'YOUR_API_KEY_HERE') {
                errorDiv.textContent = 'Cloud sync not configured. Please follow setup instructions.';
                return;
            }

            // Try to load data from this bin ID
            try {
                const response = await fetch(`https://api.jsonbin.io/v3/b/${schoolId}/latest`, {
                    headers: {
                        'X-Master-Key': JSONBIN_API_KEY
                    }
                });

                if (response.ok) {
                    const result = await response.json();
                    const data = result.record;
                    
                    // Verify this is a valid school (has teachers)
                    if (!data.teachers || data.teachers.length === 0) {
                        errorDiv.textContent = 'Invalid School ID. Please check and try again.';
                        return;
                    }

                    // Save the bin ID
                    binId = schoolId;
                    localStorage.setItem('schoolBinId', schoolId);
                    
                    // Load the data
                    students = data.students || [];
                    currentWeek = data.currentWeek || 1;
                    weeklyWinners = data.weeklyWinners || [];
                    bigRaffleWinners = data.bigRaffleWinners || [];
                    teachers = data.teachers || [];
                    auditLog = data.auditLog || [];
                    
                    saveData(); // Save locally
                    
                    alert('✅ Successfully connected to school!\n\nYou can now log in with your teacher credentials.');
                    backToLogin();
                    
                    // Hide create admin button since school exists
                    const createAdminSection = document.getElementById('createAdminSection');
                    if (createAdminSection) {
                        createAdminSection.style.display = 'none';
                    }
                } else {
                    errorDiv.textContent = 'Invalid School ID. Please check and try again.';
                }
            } catch (error) {
                console.error('Connection error:', error);
                errorDiv.textContent = 'Connection failed. Please check your internet and try again.';
            }
        }

        function createAdminAccount() {
            const name = document.getElementById('adminName').value.trim();
            const username = document.getElementById('adminUsername').value.trim();
            const password = document.getElementById('adminPassword').value;
            const confirm = document.getElementById('adminPasswordConfirm').value;
            const errorDiv = document.getElementById('adminError');

            if (!name || !username || !password) {
                errorDiv.textContent = 'Please fill in all fields';
                return;
            }

            if (password !== confirm) {
                errorDiv.textContent = 'Passwords do not match';
                return;
            }

            if (teachers.length > 0) {
                errorDiv.textContent = 'Admin account already exists. Please login.';
                return;
            }

            teachers.push({
                id: 'T001',
                name: name,
                username: username,
                password: password,
                role: 'admin',
                ticketsAwarded: 0,
                createdDate: new Date().toISOString()
            });

            saveData();
            
            // Create cloud bin if API key is configured
            if (JSONBIN_API_KEY !== 'YOUR_API_KEY_HERE') {
                createCloudBin();
            } else {
                alert('Admin account created! Please login.\n\n⚠️ Note: Cloud sync is not configured. Data will only be saved on this device.\n\nTo enable multi-device sync, follow the setup instructions.');
            }
            
            // Hide create admin button now that admin exists
            const createAdminSection = document.getElementById('createAdminSection');
            if (createAdminSection) {
                createAdminSection.style.display = 'none';
            }
            
            backToLogin();
        }

        function getFriendlyRoleName(role) {
            const roleNames = {
                'teacher': 'Teacher',
                'campusaide': 'Campus Aide',
                'admin': 'Admin',
                'superadmin': 'Super Admin'
            };
            return roleNames[role] || role;
        }

        function login() {
            const username = document.getElementById('loginUsername').value.trim();
            const password = document.getElementById('loginPassword').value;
            const errorDiv = document.getElementById('loginError');

            if (!username || !password) {
                errorDiv.textContent = 'Please enter username and password';
                return;
            }

            const teacher = teachers.find(t => t.username === username && t.password === password);

            if (!teacher) {
                errorDiv.textContent = 'Invalid username or password';
                return;
            }

            currentUser = teacher;
            
            // Track login activity
            const loginRecord = {
                id: 'login_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                userId: teacher.id,
                username: teacher.username,
                name: teacher.name,
                role: teacher.role,
                timestamp: new Date().toISOString(),
                userAgent: navigator.userAgent,
                platform: navigator.platform
            };
            
            loginHistory.push(loginRecord);
            
            // Keep only last 500 login records to prevent unbounded growth
            if (loginHistory.length > 500) {
                loginHistory = loginHistory.slice(-500);
            }
            
            saveSession(); // Save session for auto-login
            saveData(); // Save login history to cloud
            
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('createAdminScreen').classList.add('hidden');
            document.getElementById('mainApp').classList.remove('hidden');
            
            document.getElementById('currentUserName').textContent = teacher.name;
            document.getElementById('currentUserRole').textContent = getFriendlyRoleName(teacher.role);
            
            // Force admin, teacher, and campus aide users to Raffle Mode only
            if (teacher.role === 'teacher' || teacher.role === 'campusaide' || teacher.role === 'admin') {
                wildcatCashEnabled = false;
                localStorage.setItem('systemMode', 'raffle');
                document.body.classList.remove('cash-mode', 'hallpass-mode', 'discipline-mode');
                document.body.classList.add('raffle-mode');
                
                // Ensure tabs are visible
                const tabsContainer = document.querySelector('.tabs');
                if (tabsContainer) tabsContainer.style.display = 'flex';
                
                // Ensure content container is visible
                const contentContainer = document.querySelector('.content');
                if (contentContainer) {
                    contentContainer.style.display = 'block';
                    // Remove any inline display styles from tab-content divs
                    contentContainer.querySelectorAll('.tab-content').forEach(el => el.style.display = '');
                }
                
                // Hide Claw Pass and Discipline content for non-superadmins
                const clawPassContent = document.getElementById('clawPassContent');
                const disciplineContent = document.getElementById('disciplineContent');
                if (clawPassContent) clawPassContent.style.display = 'none';
                if (disciplineContent) disciplineContent.style.display = 'none';
            }
            
            // Show/hide tabs based on role
            const adminTabs = document.querySelectorAll('.admin-only');
            const superAdminTabs = document.querySelectorAll('.super-admin-only');
            
            if (teacher.role === 'teacher' || teacher.role === 'campusaide') {
                // Teachers and Campus Aides only see basic tabs
                adminTabs.forEach(tab => tab.classList.add('disabled'));
                superAdminTabs.forEach(tab => tab.classList.add('disabled'));
                
                // Hide week controls for teachers and campus aides
                const weekControls = document.getElementById('weekControls');
                if (weekControls) weekControls.style.display = 'none';
                
                switchTab('tickets');
            } else if (teacher.role === 'admin') {
                // Admins see admin tabs but not super admin tabs
                adminTabs.forEach(tab => tab.classList.remove('disabled'));
                superAdminTabs.forEach(tab => tab.classList.add('disabled'));
                
                // Show week controls for admins
                const weekControls = document.getElementById('weekControls');
                if (weekControls) weekControls.style.display = 'flex';
                
                switchTab('students');
            } else if (teacher.role === 'superadmin') {
                // Super admins see everything
                adminTabs.forEach(tab => tab.classList.remove('disabled'));
                superAdminTabs.forEach(tab => tab.classList.remove('disabled'));
                
                // Show week controls for super admins
                const weekControls = document.getElementById('weekControls');
                if (weekControls) weekControls.style.display = 'flex';
                
                // Restore superadmin's saved mode preference or default to raffle
                const savedMode = localStorage.getItem('systemMode') || 'raffle';
                if (savedMode === 'cash') {
                    wildcatCashEnabled = true;
                    document.body.classList.remove('raffle-mode', 'hallpass-mode');
                    document.body.classList.add('cash-mode');
                } else if (savedMode === 'hallpass') {
                    document.body.classList.remove('raffle-mode', 'cash-mode');
                    document.body.classList.add('hallpass-mode');
                    const clawPassContent = document.getElementById('clawPassContent');
                    const tabsContainer = document.querySelector('.tabs');
                    if (tabsContainer) tabsContainer.style.display = 'none';
                    if (clawPassContent) clawPassContent.style.display = 'block';
                    
                    // Make sure subtab buttons are visible for admins/teachers
                    document.querySelectorAll('.subtab-button').forEach(btn => {
                        btn.style.display = '';
                    });
                    
                    switchHallPassTab('kiosk');
                } else {
                    wildcatCashEnabled = false;
                    document.body.classList.remove('cash-mode', 'hallpass-mode');
                    document.body.classList.add('raffle-mode');
                    // Ensure normal content is visible for raffle mode
                    const tabsContainer = document.querySelector('.tabs');
                    if (tabsContainer) tabsContainer.style.display = 'flex';
                    const contentContainer = document.querySelector('.content');
                    if (contentContainer) {
                        contentContainer.querySelectorAll('.tab-content').forEach(el => el.style.display = '');
                    }
                }
                
                updateModeToggleUI();
                updateTabVisibility();
                switchTab('students');
            }

            updateAllDisplays();
            if (teacher.role === 'superadmin' || teacher.role === 'admin') {
                updateSuperAdminList();
            }
            
            // Check if we need to auto-reset the week
            checkAndRunAutoWeekReset();
        }

        function logout() {
            if (confirm('Are you sure you want to logout?')) {
                currentUser = null;
                currentStudent = null;
                clearSession(); // Clear saved session
                
                document.getElementById('mainApp').classList.add('hidden');
                document.getElementById('studentApp').classList.add('hidden');
                document.getElementById('loginScreen').classList.remove('hidden');
                document.getElementById('loginUsername').value = '';
                document.getElementById('loginPassword').value = '';
                document.getElementById('studentLoginId').value = '';
                document.getElementById('loginError').textContent = '';
                document.getElementById('studentLoginError').textContent = '';
                showTeacherLogin(); // Default to teacher login
            }
        }

        function addToAuditLog(action, studentId, category, ticketCount, reason, periodInfo = null) {
            const student = students.find(s => s.id === studentId);
            const logEntry = {
                timestamp: new Date().toISOString(),
                teacher: currentUser.name,
                teacherId: currentUser.id,
                action: action,
                studentId: studentId,
                studentName: student ? `${student.firstName} ${student.lastName}` : 'Unknown',
                category: category,
                ticketCount: ticketCount,
                reason: reason,
                week: currentWeek  // Track which week this entry is from
            };
            
            // Add period info if provided
            if (periodInfo) {
                logEntry.period = periodInfo.period;
                logEntry.courseName = periodInfo.courseName;
            }
            
            auditLog.push(logEntry);
            saveData();
        }

        function updateAuditLogTable() {
            const tbody = document.getElementById('auditLogTable');
            
            // Filter to only show RAFFLE MODE transactions
            const raffleAuditLog = auditLog.filter(log => {
                // Only include raffle-related actions
                const raffleActions = ['Awarded Tickets', 'Removed Tickets', 'Raffle Winner', 
                                      'Weekly Raffle Winner', 'Wildcat Jackpot Winner', 
                                      'Reset Wildcat Jackpot Cycle', '↩️ UNDID Award'];
                return raffleActions.includes(log.action);
            });
            
            if (raffleAuditLog.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px; color: #999;">No activity logged yet</td></tr>';
                return;
            }

            // Show most recent first
            const sorted = [...raffleAuditLog].reverse();
            const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'superadmin');
            
            tbody.innerHTML = sorted.map((log, index) => {
                const date = new Date(log.timestamp);
                const formattedDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
                const originalIndex = auditLog.length - 1 - index; // Get original index
                
                // Determine action styling
                let actionBadge = '';
                let rowStyle = '';
                let actionIcon = '';
                
                if (log.action === 'Awarded Tickets') {
                    actionBadge = 'background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(102, 126, 234, 0.3);';
                    rowStyle = 'background: linear-gradient(to right, rgba(102, 126, 234, 0.08), transparent); border-left: 4px solid #667eea;';
                    actionIcon = '🎟️';
                } else if (log.action === '↩️ UNDID Award') {
                    actionBadge = 'background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(245, 158, 11, 0.3);';
                    rowStyle = 'background: linear-gradient(to right, rgba(245, 158, 11, 0.08), transparent); border-left: 4px solid #f59e0b;';
                    actionIcon = '↩️';
                } else if (log.action === 'Removed Tickets') {
                    actionBadge = 'background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(245, 87, 108, 0.3);';
                    rowStyle = 'background: linear-gradient(to right, rgba(245, 87, 108, 0.08), transparent); border-left: 4px solid #f5576c;';
                    actionIcon = '❌';
                } else if (log.action === 'Raffle Winner' || log.action === 'Weekly Raffle Winner') {
                    actionBadge = 'background: linear-gradient(135deg, #ffd89b 0%, #19547b 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(255, 215, 0, 0.4);';
                    rowStyle = 'background: linear-gradient(to right, rgba(255, 215, 0, 0.12), transparent); border-left: 4px solid #ffd700;';
                    actionIcon = '🏆';
                } else if (log.action === 'Wildcat Jackpot Winner') {
                    actionBadge = 'background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%, #ffd89b 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(240, 147, 251, 0.4); animation: pulse 2s infinite;';
                    rowStyle = 'background: linear-gradient(to right, rgba(240, 147, 251, 0.15), transparent); border-left: 4px solid #f093fb;';
                    actionIcon = '🎊';
                } else if (log.action === 'Reset Wildcat Jackpot Cycle') {
                    actionBadge = 'background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(79, 172, 254, 0.3);';
                    rowStyle = 'background: linear-gradient(to right, rgba(79, 172, 254, 0.08), transparent); border-left: 4px solid #4facfe;';
                    actionIcon = '🔄';
                } else {
                    actionBadge = 'background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%); color: #333; padding: 6px 12px; border-radius: 20px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(168, 237, 234, 0.3);';
                    rowStyle = 'background: linear-gradient(to right, rgba(168, 237, 234, 0.08), transparent); border-left: 4px solid #a8edea;';
                    actionIcon = '📝';
                }
                
                return `
                    <tr style="${rowStyle}">
                        <td style="padding: 12px 8px;">
                            <span style="font-size: 13px; color: #666;">${formattedDate}</span>
                        </td>
                        <td style="padding: 12px 8px;">
                            <span class="teacher-badge" style="background: #e3f2fd; color: #1976d2; padding: 4px 10px; border-radius: 12px; font-size: 13px; font-weight: 500;">${log.teacher}</span>
                        </td>
                        <td style="padding: 12px 8px;">
                            <span style="${actionBadge}">
                                ${actionIcon} ${log.action}
                            </span>
                        </td>
                        <td style="padding: 12px 8px; font-weight: 500;">${log.studentName}</td>
                        <td style="padding: 12px 8px;">
                            ${log.category ? `<span style="background: #f5f5f5; padding: 4px 8px; border-radius: 8px; font-size: 12px;">${log.category}</span>` : '<span style="color: #999;">-</span>'}
                        </td>
                        <td style="padding: 12px 8px; text-align: center;">
                            ${log.ticketCount ? `<span style="font-weight: 700; font-size: 16px; color: #667eea;">${log.ticketCount}</span>` : '<span style="color: #999;">-</span>'}
                        </td>
                        <td style="padding: 12px 8px; max-width: 200px;">
                            ${log.reason ? `<span style="font-size: 13px; color: #555;">${log.reason}</span>` : '<span style="color: #999;">-</span>'}
                        </td>
                        <td style="padding: 12px 8px; text-align: center;">
                            ${isAdmin && log.action === 'Awarded Tickets' ? 
                                `<button class="btn btn-danger" style="padding: 6px 12px; font-size: 12px; background: linear-gradient(135deg, #f5576c 0%, #f093fb 100%); border: none; border-radius: 8px; box-shadow: 0 2px 4px rgba(245, 87, 108, 0.3);" 
                                         onclick="deleteTicketEntry(${originalIndex})">
                                    🗑️ Delete
                                </button>` 
                                : '<span style="color: #999;">-</span>'}
                        </td>
                    </tr>
                `;
            }).join('');
        }
        
        // Login Activity Functions
        function updateLoginActivityTable() {
            const tbody = document.getElementById('loginActivityTableBody');
            const searchUser = document.getElementById('loginSearchUser')?.value.toLowerCase() || '';
            const filterRole = document.getElementById('loginFilterRole')?.value || '';
            const dateRange = document.getElementById('loginDateRange')?.value || 'all';
            
            if (!tbody) return;
            
            // Filter logins
            let filteredLogins = loginHistory.filter(login => {
                // Search filter
                if (searchUser && !login.name.toLowerCase().includes(searchUser) && !login.username.toLowerCase().includes(searchUser)) {
                    return false;
                }
                
                // Role filter
                if (filterRole && login.role !== filterRole) {
                    return false;
                }
                
                // Date range filter
                if (dateRange !== 'all') {
                    const loginDate = new Date(login.timestamp);
                    const now = new Date();
                    const diffTime = now - loginDate;
                    const diffDays = diffTime / (1000 * 60 * 60 * 24);
                    
                    if (dateRange === 'today' && diffDays > 1) return false;
                    if (dateRange === 'week' && diffDays > 7) return false;
                    if (dateRange === 'month' && diffDays > 30) return false;
                }
                
                return true;
            });
            
            // Sort by most recent first
            filteredLogins.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            // Update stats
            updateLoginStats(filteredLogins);
            
            // Render table
            if (filteredLogins.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="padding: 40px; text-align: center; color: #999;">No login activity found</td></tr>';
                return;
            }
            
            tbody.innerHTML = filteredLogins.map(login => {
                const date = new Date(login.timestamp);
                const formattedDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                const formattedTime = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                
                // Role badge styling
                let roleColor = '#6c757d';
                let roleIcon = '👤';
                if (login.role === 'superadmin') {
                    roleColor = '#dc3545';
                    roleIcon = '👑';
                } else if (login.role === 'admin') {
                    roleColor = '#667eea';
                    roleIcon = '⭐';
                } else if (login.role === 'campusaide') {
                    roleColor = '#10b981';
                    roleIcon = '👁️';
                } else if (login.role === 'teacher') {
                    roleColor = '#28a745';
                    roleIcon = '👤';
                }
                
                // Simplify platform display
                let platform = 'Unknown';
                if (login.platform) {
                    if (login.platform.includes('Win')) platform = '💻 Windows';
                    else if (login.platform.includes('Mac')) platform = '🍎 Mac';
                    else if (login.platform.includes('Linux')) platform = '🐧 Linux';
                    else if (login.platform.includes('iPhone') || login.platform.includes('iPad')) platform = '📱 iOS';
                    else if (login.platform.includes('Android')) platform = '📱 Android';
                    else platform = login.platform;
                }
                
                return `
                    <tr style="border-bottom: 1px solid #e9ecef;">
                        <td style="padding: 12px; color: #495057;">
                            <div style="font-weight: 600;">${formattedDate}</div>
                            <div style="font-size: 12px; color: #6c757d;">${formattedTime}</div>
                        </td>
                        <td style="padding: 12px; color: #495057; font-weight: 600;">${login.name}</td>
                        <td style="padding: 12px; color: #6c757d;">${login.username}</td>
                        <td style="padding: 12px;">
                            <span style="background: ${roleColor}; color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600;">
                                ${roleIcon} ${getFriendlyRoleName(login.role)}
                            </span>
                        </td>
                        <td style="padding: 12px; color: #6c757d;">${platform}</td>
                    </tr>
                `;
            }).join('');
        }
        
        function updateLoginStats(filteredLogins = loginHistory) {
            // Total logins
            document.getElementById('totalLoginsCount').textContent = filteredLogins.length;
            
            // Unique users
            const uniqueUsers = new Set(filteredLogins.map(l => l.userId));
            document.getElementById('uniqueUsersCount').textContent = uniqueUsers.size;
            
            // Logins today
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayLogins = filteredLogins.filter(l => new Date(l.timestamp) >= today);
            document.getElementById('todayLoginsCount').textContent = todayLogins.length;
        }
        
        function exportLoginActivity() {
            if (loginHistory.length === 0) {
                alert('No login activity to export');
                return;
            }
            
            // Create CSV content
            const headers = ['Date', 'Time', 'User Name', 'Username', 'Role', 'Platform'];
            const rows = loginHistory.map(login => {
                const date = new Date(login.timestamp);
                const formattedDate = date.toLocaleDateString('en-US');
                const formattedTime = date.toLocaleTimeString('en-US');
                
                return [
                    formattedDate,
                    formattedTime,
                    login.name,
                    login.username,
                    getFriendlyRoleName(login.role),
                    login.platform || 'Unknown'
                ];
            });
            
            const csvContent = [
                headers.join(','),
                ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
            ].join('\n');
            
            // Download CSV
            const blob = new Blob([csvContent], { type: 'text/csv' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `login-activity-${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            
            alert('✅ Login activity exported successfully!');
        }
        
        function deleteTicketEntry(logIndex) {
            if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
                alert('Only admins can delete ticket entries');
                return;
            }
            
            const entry = auditLog[logIndex];
            
            if (!entry) {
                alert('Entry not found');
                return;
            }
            
            // Confirm deletion
            if (!confirm(`⚠️ DELETE TICKET ENTRY?\n\n` +
                        `Teacher: ${entry.teacher}\n` +
                        `Student: ${entry.studentName}\n` +
                        `Category: ${entry.category}\n` +
                        `Tickets: ${entry.ticketCount}\n` +
                        `Reason: ${entry.reason}\n\n` +
                        `This will:\n` +
                        `• Remove ${entry.ticketCount} ticket(s) from the student\n` +
                        `• Delete this audit log entry\n` +
                        `• Cannot be undone\n\n` +
                        `Continue?`)) {
                return;
            }
            
            // Find the student
            const student = students.find(s => s.id === entry.studentId);
            
            if (!student) {
                alert('Student not found. The audit entry will be deleted, but tickets cannot be reversed.');
            } else {
                // Reverse the ticket award
                const category = entry.category.toLowerCase();
                const ticketCount = parseInt(entry.ticketCount) || 0;
                
                if (category === 'pbis') {
                    student.pbisTickets = Math.max(0, student.pbisTickets - ticketCount);
                } else if (category === 'attendance') {
                    student.attendanceTickets = Math.max(0, student.attendanceTickets - ticketCount);
                } else if (category === 'academics') {
                    student.academicTickets = Math.max(0, student.academicTickets - ticketCount);
                }
                
                // Remove from student's ticket history
                student.ticketHistory = student.ticketHistory.filter((h, i) => {
                    // Try to match by timestamp and ticket count
                    return !(h.timestamp === entry.timestamp && h.count === ticketCount);
                });
            }
            
            // Remove from audit log
            auditLog.splice(logIndex, 1);
            
            // Add deletion record to audit log
            auditLog.push({
                timestamp: new Date().toISOString(),
                teacher: currentUser.name,
                teacherId: currentUser.id,
                action: 'Deleted Ticket Entry',
                studentId: entry.studentId,
                studentName: entry.studentName,
                category: entry.category,
                ticketCount: entry.ticketCount,
                reason: `Deleted entry by ${entry.teacher} - Original reason: ${entry.reason}`
            });
            
            saveData();
            updateAllDisplays();
            
            alert(`✅ Ticket entry deleted!\n\n` +
                  `${entry.ticketCount} ticket(s) removed from ${entry.studentName}\n` +
                  `Audit log updated.`);
        }

        function searchAuditLog() {
            const search = document.getElementById('searchAudit').value.toLowerCase();
            const rows = document.querySelectorAll('#auditLogTable tr');
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(search) ? '' : 'none';
            });
        }

        function updateCashAuditLogTable() {
            const tbody = document.getElementById('cashAuditLogTable');
            
            // Filter to only show CASH MODE transactions from auditLog
            const cashAuditLog = auditLog.filter(log => {
                // Only include cash-related actions
                const cashActions = ['cash_award', 'cash_deduct', 'reward_redemption', 'reset_all_student_cash'];
                return cashActions.includes(log.action);
            });
            
            if (cashAuditLog.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: #999;">No cash activity logged yet</td></tr>';
                return;
            }

            // Show most recent first
            const sorted = [...cashAuditLog].reverse();
            
            tbody.innerHTML = sorted.map(log => {
                const date = new Date(log.timestamp);
                const formattedDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
                
                // Determine styling based on action
                let actionBadge = '';
                let rowStyle = '';
                let actionIcon = '';
                let actionText = '';
                
                if (log.action === 'cash_award') {
                    actionBadge = 'background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(16, 185, 129, 0.3);';
                    rowStyle = 'background: linear-gradient(to right, rgba(16, 185, 129, 0.08), transparent); border-left: 4px solid #10b981;';
                    actionIcon = '💰';
                    actionText = 'Cash Awarded';
                } else if (log.action === 'cash_deduct') {
                    actionBadge = 'background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(239, 68, 68, 0.3);';
                    rowStyle = 'background: linear-gradient(to right, rgba(239, 68, 68, 0.08), transparent); border-left: 4px solid #ef4444;';
                    actionIcon = '⚠️';
                    actionText = 'Cash Deducted';
                } else if (log.action === 'reward_redemption') {
                    actionBadge = 'background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(139, 92, 246, 0.3);';
                    rowStyle = 'background: linear-gradient(to right, rgba(139, 92, 246, 0.08), transparent); border-left: 4px solid #8b5cf6;';
                    actionIcon = '🎁';
                    actionText = 'Reward Redeemed';
                } else if (log.action === 'reset_all_student_cash') {
                    actionBadge = 'background: linear-gradient(135deg, #dc3545 0%, #c82333 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(220, 53, 69, 0.3);';
                    rowStyle = 'background: linear-gradient(to right, rgba(220, 53, 69, 0.08), transparent); border-left: 4px solid #dc3545;';
                    actionIcon = '🔄';
                    actionText = 'System Reset';
                } else {
                    actionBadge = 'background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%); color: #333; padding: 6px 12px; border-radius: 20px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(168, 237, 234, 0.3);';
                    rowStyle = 'background: linear-gradient(to right, rgba(168, 237, 234, 0.08), transparent); border-left: 4px solid #a8edea;';
                    actionIcon = '📝';
                    actionText = log.action;
                }
                
                // Get student name safely
                const studentName = log.details && log.details.includes(' ') ? 
                    log.details.split(' ')[0] + ' ' + log.details.split(' ')[1] : 
                    (log.studentId ? `Student #${log.studentId}` : 'Unknown');
                
                // Parse amount and behavior from details
                let behaviorName = '-';
                let amount = '-';
                
                if (log.details) {
                    // Try to extract behavior name and amount
                    const detailMatch = log.details.match(/(.+?) (?:awarded|deducted|redeemed) (.+?) for \$(\d+)/);
                    if (detailMatch) {
                        behaviorName = detailMatch[2];
                        amount = log.action === 'cash_deduct' ? `-$${detailMatch[3]}` : `+$${detailMatch[3]}`;
                    } else if (log.details.includes('$')) {
                        // Try to extract just the amount
                        const amountMatch = log.details.match(/\$(\d+)/);
                        if (amountMatch) {
                            amount = log.action === 'cash_deduct' ? `-$${amountMatch[1]}` : `+$${amountMatch[1]}`;
                        }
                    }
                }
                
                return `
                    <tr style="${rowStyle}">
                        <td style="padding: 12px 8px;">
                            <span style="font-size: 13px; color: #666;">${formattedDate}</span>
                        </td>
                        <td style="padding: 12px 8px;">
                            <span class="teacher-badge" style="background: #e3f2fd; color: #1976d2; padding: 4px 10px; border-radius: 12px; font-size: 13px; font-weight: 500;">${log.teacherName || 'System'}</span>
                        </td>
                        <td style="padding: 12px 8px;">
                            <span style="${actionBadge}">
                                ${actionIcon} ${actionText}
                            </span>
                        </td>
                        <td style="padding: 12px 8px; font-weight: 500;">${studentName}</td>
                        <td style="padding: 12px 8px;">
                            <span style="background: #f5f5f5; padding: 4px 8px; border-radius: 8px; font-size: 12px;">${behaviorName}</span>
                        </td>
                        <td style="padding: 12px 8px; text-align: center;">
                            <span style="font-weight: 700; font-size: 16px; color: ${log.action === 'cash_deduct' ? '#ef4444' : '#10b981'};">${amount}</span>
                        </td>
                        <td style="padding: 12px 8px; max-width: 250px;">
                            <span style="font-size: 13px; color: #555;">${log.details || '-'}</span>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function searchCashAuditLog() {
            const search = document.getElementById('searchCashAudit').value.toLowerCase();
            const rows = document.querySelectorAll('#cashAuditLogTable tr');
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(search) ? '' : 'none';
            });
        }

        function addTeacher() {
            if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
                alert('Only admins can add teachers');
                return;
            }

            const name = document.getElementById('newTeacherName').value.trim();
            const username = document.getElementById('newTeacherUsername').value.trim();
            const email = document.getElementById('newTeacherEmail').value.trim();
            const password = document.getElementById('newTeacherPassword').value;
            const role = document.getElementById('newTeacherRole').value;

            if (!name || !username || !password) {
                alert('Please fill in all required fields');
                return;
            }
            
            if (email && !email.includes('@')) {
                alert('Please enter a valid email address');
                return;
            }

            if (teachers.find(t => t.username === username)) {
                alert('Username already exists');
                return;
            }

            // Generate unique ID based on highest existing ID, not array length
            let maxId = 0;
            teachers.forEach(t => {
                const num = parseInt(t.id.substring(1)); // Extract number from 'T001'
                if (num > maxId) maxId = num;
            });
            const newId = 'T' + String(maxId + 1).padStart(3, '0');
            
            const newTeacher = {
                id: newId,
                name: name,
                username: username,
                email: email || '',
                password: password,
                role: role,
                ticketsAwarded: 0,
                createdDate: new Date().toISOString(),
                sections: []
            };
            
            // Try to match with CSV data
            const matched = matchTeacherToSections(newTeacher);
            
            teachers.push(newTeacher);

            saveData();
            updateTeachersTable();
            
            document.getElementById('newTeacherName').value = '';
            document.getElementById('newTeacherUsername').value = '';
            document.getElementById('newTeacherEmail').value = '';
            document.getElementById('newTeacherPassword').value = '';
            
            if (matched) {
                alert(`✅ Teacher added successfully!\n\n` +
                      `${newTeacher.sections.length} class sections auto-assigned from CSV.\n` +
                      `${name} can now use period filtering!`);
            } else {
                alert(`Teacher added successfully!\n\n` +
                      `Note: No matching schedule found in CSV for "${name}".\n` +
                      `Make sure the name matches exactly as it appears in PowerSchool.`);
            }
        }

        let editingTeacherId = null;
        
        function editTeacher(teacherId) {
            const teacher = teachers.find(t => t.id === teacherId);
            if (!teacher) {
                alert('Teacher not found');
                return;
            }
            
            editingTeacherId = teacherId;
            
            // Populate form
            document.getElementById('editTeacherName').value = teacher.name || '';
            document.getElementById('editTeacherUsername').value = teacher.username || '';
            document.getElementById('editTeacherEmail').value = teacher.email || '';
            document.getElementById('editTeacherRole').value = teacher.role || 'teacher';
            
            // Show modal
            document.getElementById('editTeacherModal').classList.remove('hidden');
        }
        
        function closeEditTeacherModal() {
            document.getElementById('editTeacherModal').classList.add('hidden');
            editingTeacherId = null;
        }
        
        function saveTeacherEdit() {
            if (!editingTeacherId) return;
            
            const teacher = teachers.find(t => t.id === editingTeacherId);
            if (!teacher) {
                alert('Teacher not found');
                return;
            }
            
            const name = document.getElementById('editTeacherName').value.trim();
            const email = document.getElementById('editTeacherEmail').value.trim();
            const role = document.getElementById('editTeacherRole').value;
            
            if (!name) {
                alert('Please enter a name');
                return;
            }
            
            if (email && !email.includes('@')) {
                alert('Please enter a valid email address');
                return;
            }
            
            // Update teacher
            teacher.name = name;
            teacher.email = email;
            teacher.role = role;
            
            // If name changed, try to re-match to CSV sections
            matchTeacherToSections(teacher);
            
            // If editing current user, update currentUser reference
            if (editingTeacherId === currentUser.id) {
                currentUser = teacher;
                saveSession(); // Update session
                
                // Update display
                document.getElementById('currentUserName').textContent = teacher.name;
                document.getElementById('currentUserRole').textContent = getFriendlyRoleName(teacher.role);
            }
            
            saveData();
            updateTeachersTable();
            updateAllDisplays(); // Refresh all displays including period filter
            closeEditTeacherModal();
            
            alert(`✅ Teacher updated!\n\n${name}'s information has been saved.`);
        }

        function deleteTeacher(teacherId) {
            if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
                alert('Only admins can delete teachers');
                return;
            }

            if (teacherId === currentUser.id) {
                alert('You cannot delete your own account');
                return;
            }

            if (confirm('Are you sure you want to delete this teacher?')) {
                teachers = teachers.filter(t => t.id !== teacherId);
                saveData();
                updateTeachersTable();
            }
        }

        // System Admin Functions
        function promoteToSuperAdmin() {
            if (currentUser.role !== 'superadmin') {
                alert('Only Super Admins can promote others');
                return;
            }

            const selectElement = document.getElementById('promoteAdminSelect');
            const teacherId = selectElement.value;

            if (!teacherId) {
                alert('Please select an admin to promote');
                return;
            }

            const teacher = teachers.find(t => t.id === teacherId);
            if (!teacher) {
                alert('Teacher not found');
                return;
            }

            if (confirm(`Promote ${teacher.name} to Super Admin?\n\nThey will have access to:\n• System reset\n• All admin features\n• Promote other admins`)) {
                teacher.role = 'superadmin';
                saveData();
                updateTeachersTable();
                updateSuperAdminList();
                alert(`${teacher.name} is now a Super Admin!`);
            }
        }

        function updateSuperAdminList() {
            const select = document.getElementById('promoteAdminSelect');
            if (!select) return;

            const admins = teachers.filter(t => t.role === 'admin');
            
            select.innerHTML = '<option value="">Select an admin...</option>';
            admins.forEach(admin => {
                const option = document.createElement('option');
                option.value = admin.id;
                option.textContent = `${admin.name} (${admin.username})`;
                select.appendChild(option);
            });
        }

        function resetSystemData() {
            if (currentUser.role !== 'superadmin') {
                alert('Only Super Admins can reset the system');
                return;
            }

            const confirmation = document.getElementById('resetConfirmation').value;
            
            if (confirmation !== 'DELETE ALL DATA') {
                alert('Please type "DELETE ALL DATA" exactly to confirm');
                return;
            }

            if (!confirm('⚠️ FINAL WARNING ⚠️\n\nThis will PERMANENTLY DELETE:\n• All students\n• All tickets\n• All raffle winners\n• All audit logs\n• All weekly history\n\nThis CANNOT be undone!\n\nAre you ABSOLUTELY SURE?')) {
                return;
            }

            // Second confirmation
            if (!confirm('Last chance! Click OK to DELETE EVERYTHING or Cancel to abort.')) {
                return;
            }

            // Reset all data
            students = [];
            currentWeek = 1;
            weeklyWinners = [];
            bigRaffleWinners = [];
            auditLog = [];
            weeklyHistory = [];

            // Keep teachers and settings
            // teachers = teachers; (already preserved)
            // pbisSubcategories and academicSubcategories preserved

            // Save the reset
            saveData();
            updateAllDisplays();

            // Clear confirmation field
            document.getElementById('resetConfirmation').value = '';

            alert('✅ System has been reset!\n\nAll student data, tickets, and history have been deleted.\n\nTeacher accounts and settings have been preserved.');
        }

        function exportFullSystemBackup() {
            const backup = {
                exportDate: new Date().toISOString(),
                students: students,
                currentWeek: currentWeek,
                weeklyWinners: weeklyWinners,
                bigRaffleWinners: bigRaffleWinners,
                teachers: teachers,
                auditLog: auditLog,
                weeklyHistory: weeklyHistory,
                pbisSubcategories: pbisSubcategories,
                academicSubcategories: academicSubcategories
            };

            const dataStr = JSON.stringify(backup, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `Westbrook_Raffle_Backup_${new Date().toISOString().split('T')[0]}.json`;
            link.click();
            URL.revokeObjectURL(url);

            alert('✅ Full system backup downloaded!\n\nKeep this file safe in case you need to restore data.');
        }

        function showChangePassword() {
            document.getElementById('mainApp').classList.add('hidden');
            document.getElementById('changePasswordModal').classList.remove('hidden');
            document.getElementById('currentPasswordInput').value = '';
            document.getElementById('newPasswordInput').value = '';
            document.getElementById('confirmPasswordInput').value = '';
            document.getElementById('changePasswordError').textContent = '';
        }

        function closeChangePassword() {
            document.getElementById('changePasswordModal').classList.add('hidden');
            document.getElementById('mainApp').classList.remove('hidden');
        }

        async function changePassword() {
            const currentPassword = document.getElementById('currentPasswordInput').value;
            const newPassword = document.getElementById('newPasswordInput').value;
            const confirmPassword = document.getElementById('confirmPasswordInput').value;
            const errorDiv = document.getElementById('changePasswordError');

            if (!currentPassword || !newPassword || !confirmPassword) {
                errorDiv.textContent = 'Please fill in all fields';
                return;
            }

            if (currentPassword !== currentUser.password) {
                errorDiv.textContent = 'Current password is incorrect';
                return;
            }

            if (newPassword.length < 4) {
                errorDiv.textContent = 'New password must be at least 4 characters';
                return;
            }

            if (newPassword !== confirmPassword) {
                errorDiv.textContent = 'New passwords do not match';
                return;
            }

            // Update password
            const teacher = teachers.find(t => t.id === currentUser.id);
            if (teacher) {
                teacher.password = newPassword;
                currentUser.password = newPassword;
                await saveData();
                saveSession(); // Update session with new password
                
                alert('✅ Password changed successfully!');
                closeChangePassword();
            } else {
                errorDiv.textContent = 'Error updating password. Please try again.';
            }
        }

        // Add Cash Modal Functions
        let selectedStudentForCash = null;

        function showAddCashModal(studentId) {
            const student = students.find(s => s.id === studentId);
            if (!student) return;
            
            selectedStudentForCash = student;
            document.getElementById('addCashStudentName').textContent = `${student.firstName} ${student.lastName}`;
            
            // Populate positive behaviors dropdown
            const behaviorSelect = document.getElementById('addCashBehaviorSelect');
            behaviorSelect.innerHTML = '<option value="">Select positive behavior...</option>';
            
            const positiveBehaviors = wildcatCashBehaviors.filter(b => b.type === 'positive' && b.active !== false);
            positiveBehaviors.forEach(behavior => {
                const option = document.createElement('option');
                option.value = behavior.id;
                option.textContent = `${behavior.name} (+$${behavior.points})`;
                behaviorSelect.appendChild(option);
            });
            
            document.getElementById('addCashAmount').value = '';
            document.getElementById('addCashNotes').value = '';
            
            document.getElementById('mainApp').classList.add('hidden');
            document.getElementById('addCashModal').classList.remove('hidden');
        }

        function updateAddCashAmount() {
            const behaviorId = document.getElementById('addCashBehaviorSelect').value;
            const amountInput = document.getElementById('addCashAmount');
            
            if (behaviorId) {
                const behavior = wildcatCashBehaviors.find(b => b.id === behaviorId);
                if (behavior) {
                    amountInput.value = behavior.points;
                }
            } else {
                amountInput.value = '';
            }
        }

        function cancelAddCash() {
            selectedStudentForCash = null;
            document.getElementById('addCashModal').classList.add('hidden');
            document.getElementById('mainApp').classList.remove('hidden');
        }

        async function confirmAddCash() {
            const behaviorId = document.getElementById('addCashBehaviorSelect').value;
            const notes = document.getElementById('addCashNotes').value.trim();
            
            if (!behaviorId) {
                alert('Please select a behavior');
                return;
            }
            
            const behavior = wildcatCashBehaviors.find(b => b.id === behaviorId);
            if (!behavior) {
                alert('Invalid behavior selected');
                return;
            }
            
            if (!selectedStudentForCash) return;
            
            const amount = behavior.points;
            
            // Initialize if needed
            if (selectedStudentForCash.wildcatCashBalance === undefined) {
                selectedStudentForCash.wildcatCashBalance = STARTING_BALANCE;
                selectedStudentForCash.wildcatCashEarned = 0;
                selectedStudentForCash.wildcatCashSpent = 0;
                selectedStudentForCash.wildcatCashDeducted = 0;
                selectedStudentForCash.wildcatCashTransactions = [];
            }
            
            // Add the cash
            selectedStudentForCash.wildcatCashBalance += amount;
            selectedStudentForCash.wildcatCashEarned += amount;
            
            // Record transaction
            const transaction = {
                timestamp: new Date().toISOString(),
                amount: amount,
                behaviorId: behavior.id,
                behaviorName: behavior.name,
                notes: notes || '',
                type: 'positive',
                addedBy: currentUser.username
            };
            
            selectedStudentForCash.wildcatCashTransactions.push(transaction);
            wildcatCashTransactions.push({
                ...transaction,
                studentId: selectedStudentForCash.id,
                studentName: `${selectedStudentForCash.firstName} ${selectedStudentForCash.lastName}`
            });
            
            await saveData();
            alert(`✅ Successfully added $${amount} to ${selectedStudentForCash.firstName} ${selectedStudentForCash.lastName}'s account!\n\nBehavior: ${behavior.name}`);
            
            cancelAddCash();
            updateStudentAccounts();
        }

        // Remove Cash Modal Functions
        function showRemoveCashModal(studentId) {
            const student = students.find(s => s.id === studentId);
            if (!student) return;
            
            selectedStudentForCash = student;
            document.getElementById('removeCashStudentName').textContent = `${student.firstName} ${student.lastName}`;
            
            // Populate negative behaviors dropdown
            const behaviorSelect = document.getElementById('removeCashBehaviorSelect');
            behaviorSelect.innerHTML = '<option value="">Select negative behavior...</option>';
            
            const negativeBehaviors = wildcatCashBehaviors.filter(b => b.type === 'negative' && b.active !== false);
            negativeBehaviors.forEach(behavior => {
                const option = document.createElement('option');
                option.value = behavior.id;
                option.textContent = `${behavior.name} ($${Math.abs(behavior.points)})`;
                behaviorSelect.appendChild(option);
            });
            
            document.getElementById('removeCashAmount').value = '';
            document.getElementById('removeCashNotes').value = '';
            
            document.getElementById('mainApp').classList.add('hidden');
            document.getElementById('removeCashModal').classList.remove('hidden');
        }

        function updateRemoveCashAmount() {
            const behaviorId = document.getElementById('removeCashBehaviorSelect').value;
            const amountInput = document.getElementById('removeCashAmount');
            
            if (behaviorId) {
                const behavior = wildcatCashBehaviors.find(b => b.id === behaviorId);
                if (behavior) {
                    amountInput.value = Math.abs(behavior.points);
                }
            } else {
                amountInput.value = '';
            }
        }

        function cancelRemoveCash() {
            selectedStudentForCash = null;
            document.getElementById('removeCashModal').classList.add('hidden');
            document.getElementById('mainApp').classList.remove('hidden');
        }

        async function confirmRemoveCash() {
            const behaviorId = document.getElementById('removeCashBehaviorSelect').value;
            const notes = document.getElementById('removeCashNotes').value.trim();
            
            if (!behaviorId) {
                alert('Please select a behavior');
                return;
            }
            
            const behavior = wildcatCashBehaviors.find(b => b.id === behaviorId);
            if (!behavior) {
                alert('Invalid behavior selected');
                return;
            }
            
            if (!selectedStudentForCash) return;
            
            const amount = Math.abs(behavior.points);
            
            // Initialize if needed
            if (selectedStudentForCash.wildcatCashBalance === undefined) {
                selectedStudentForCash.wildcatCashBalance = STARTING_BALANCE;
                selectedStudentForCash.wildcatCashEarned = 0;
                selectedStudentForCash.wildcatCashSpent = 0;
                selectedStudentForCash.wildcatCashDeducted = 0;
                selectedStudentForCash.wildcatCashTransactions = [];
            }
            
            // Remove the cash
            selectedStudentForCash.wildcatCashBalance -= amount;
            selectedStudentForCash.wildcatCashDeducted += amount;
            
            // Record transaction
            const transaction = {
                timestamp: new Date().toISOString(),
                amount: -amount,
                behaviorId: behavior.id,
                behaviorName: behavior.name,
                notes: notes || '',
                type: 'negative',
                removedBy: currentUser.username
            };
            
            selectedStudentForCash.wildcatCashTransactions.push(transaction);
            wildcatCashTransactions.push({
                ...transaction,
                studentId: selectedStudentForCash.id,
                studentName: `${selectedStudentForCash.firstName} ${selectedStudentForCash.lastName}`
            });
            
            await saveData();
            alert(`✅ Successfully removed $${amount} from ${selectedStudentForCash.firstName} ${selectedStudentForCash.lastName}'s account!\n\nBehavior: ${behavior.name}`);
            
            cancelRemoveCash();
            updateStudentAccounts();
        }

        // ============================================
        // CLAW PASS (DIGITAL HALL PASS) FUNCTIONS
        // ============================================

        function switchHallPassTab(tabName) {
            // Hide all tabs
            document.querySelectorAll('.hall-pass-tab').forEach(tab => {
                tab.style.display = 'none';
            });
            document.querySelectorAll('.subtab-button').forEach(btn => {
                btn.style.background = '#f5f5f5';
                btn.style.color = '#333';
            });
            
            // Show selected tab
            const tabElement = document.getElementById(tabName + 'Tab');
            
            if (tabElement) {
                tabElement.style.display = 'block';
            }
            
            const btnId = tabName === 'kiosk' ? 'kioskTabBtn' : 
                          tabName === 'hallMonitor' ? 'hallMonitorTabBtn' :
                          tabName === 'snapshot' ? 'snapshotTabBtn' :
                          tabName === 'encounterPrevention' ? 'encounterPreventionTabBtn' :
                          tabName === 'history' ? 'historyTabBtn' : 'passSettingsTabBtn';
            const btn = document.getElementById(btnId);
            
            if (btn) {
                btn.style.background = '#667eea';
                btn.style.color = 'white';
            }
            
            // Load data for the tab
            if (tabName === 'hallMonitor') {
                // Set school selector cards based on current school
                const currentSchool = passSettings.currentSchool || 'highschool';
                const monitorHsCard = document.getElementById('monitorHsSchoolCard');
                const monitorMsCard = document.getElementById('monitorMsSchoolCard');
                
                if (monitorHsCard && monitorMsCard) {
                    if (currentSchool === 'highschool') {
                        monitorHsCard.style.border = '3px solid #667eea';
                        monitorHsCard.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                        monitorHsCard.style.color = 'white';
                        
                        monitorMsCard.style.border = '3px solid #e0e0e0';
                        monitorMsCard.style.background = 'white';
                        monitorMsCard.style.color = '#666';
                    } else {
                        monitorMsCard.style.border = '3px solid #10b981';
                        monitorMsCard.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
                        monitorMsCard.style.color = 'white';
                        
                        monitorHsCard.style.border = '3px solid #e0e0e0';
                        monitorHsCard.style.background = 'white';
                        monitorHsCard.style.color = '#666';
                    }
                }
                
                // Sync stat boxes with current filter
                syncStatBoxes();
                
                updateHallMonitor();
                // Auto-refresh every 30 seconds
                if (hallMonitorInterval) clearInterval(hallMonitorInterval);
                hallMonitorInterval = setInterval(updateHallMonitor, 30000);
            } else {
                // Clear interval when leaving monitor tab
                if (hallMonitorInterval) clearInterval(hallMonitorInterval);
            }
            
            if (tabName === 'snapshot') {
                // Clear any previous search
                document.getElementById('snapshotStudentSearch').value = '';
                document.getElementById('snapshotSearchResults').style.display = 'none';
                selectedSnapshotStudent = null;
                document.getElementById('snapshotContent').style.display = 'none';
            }
            
            if (tabName === 'encounterPrevention') {
                // Show/hide test mode banner
                document.getElementById('testModeBanner').style.display = encounterTestMode ? 'block' : 'none';
                // Initialize pattern detection subtab
                switchEncounterTab('patterns');
            }
            
            if (tabName === 'history') {
                updatePassHistory();
            }
            
            if (tabName === 'passSettings') {
                initializePassSettingsUI();
            }
        }

        function switchDisciplineTab(tabName) {
            // Hide all discipline subtabs
            document.querySelectorAll('.discipline-subtab').forEach(tab => {
                tab.style.display = 'none';
            });
            document.querySelectorAll('#disciplineContent .subtab-button').forEach(btn => {
                btn.style.background = '#f5f5f5';
                btn.style.color = '#333';
            });
            
            // Show selected tab
            const tabMap = {
                'submit': 'behaviorSubmit',
                'review': 'behaviorReview',
                'history': 'behaviorHistory',
                'analytics': 'behaviorAnalytics'
            };
            
            const tabElement = document.getElementById(tabMap[tabName]);
            if (tabElement) {
                tabElement.style.display = 'block';
            }
            
            // Highlight active button
            const btnMap = {
                'submit': 'submitTabBtn',
                'review': 'reviewTabBtn',
                'history': 'historyDisciplineTabBtn',
                'analytics': 'analyticsDisciplineTabBtn'
            };
            
            const btn = document.getElementById(btnMap[tabName]);
            if (btn) {
                btn.style.background = '#f59e0b';
                btn.style.color = 'white';
            }
            
            // Load data for specific tabs
            if (tabName === 'submit') {
                populateReferralStudentDropdown();
                // Set current date and time
                const now = new Date();
                const dateInput = document.getElementById('referralDate');
                const timeInput = document.getElementById('referralTime');
                if (dateInput) dateInput.value = now.toISOString().split('T')[0];
                if (timeInput) timeInput.value = now.toTimeString().slice(0,5);
            } else if (tabName === 'review') {
                updateReferralReviewTable();
            } else if (tabName === 'history') {
                populateHistoryStudentDropdown();
                // Hide summary and table initially
                document.getElementById('studentReferralSummary').classList.add('hidden');
                document.getElementById('studentReferralHistoryContainer').classList.add('hidden');
                document.getElementById('noHistoryMessage').classList.add('hidden');
            } else if (tabName === 'analytics') {
                updateReferralAnalytics();
            }
        }

        function loadStudentForPass() {
            const studentId = document.getElementById('kioskStudentId').value.trim();
            if (!studentId) {
                alert('Please enter your Student ID');
                return;
            }
            
            console.log('=== LOAD STUDENT FOR PASS ===');
            console.log('Looking for student ID:', studentId);
            console.log('Total students in array:', students.length);
            
            const student = students.find(s => s.id.toLowerCase() === studentId.toLowerCase());
            
            if (!student) {
                alert('Student ID not found. Please try again.');
                document.getElementById('kioskStudentId').value = '';
                return;
            }
            
            console.log('Found student:', student);
            console.log('Student sections:', student.sections);
            if (student.sections) {
                console.log('  Number of sections:', student.sections.length);
            }
            
            selectedKioskStudent = student;
            
            // Detect student's school from grade
            const studentSchool = getSchoolFromGrade(student.grade);
            
            // Temporarily set school context for period detection
            const previousSchool = passSettings.currentSchool;
            passSettings.currentSchool = studentSchool;
            
            // Detect current period and show to student
            let displayName = `<div style="font-size: 24px; font-weight: 600; margin-bottom: 10px;">${student.firstName} ${student.lastName}</div>`;
            
            if (passSettings.enableAutoDetection) {
                const periodInfo = detectCurrentPeriod(student, new Date());
                if (periodInfo && periodInfo.period) {
                    if (periodInfo.period !== 'Outside Class Time') {
                        displayName += `<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px; border-radius: 8px; margin-top: 10px;">`;
                        displayName += `<div style="font-size: 14px; opacity: 0.9; margin-bottom: 5px;">Currently in:</div>`;
                        displayName += `<div style="font-size: 20px; font-weight: 600;">${periodInfo.period}`;
                        if (periodInfo.teacher && periodInfo.teacher !== 'No Class') {
                            displayName += ` - ${periodInfo.teacher}`;
                        }
                        displayName += `</div>`;
                        if (periodInfo.className && periodInfo.className !== 'No Class') {
                            displayName += `<div style="font-size: 14px; opacity: 0.9; margin-top: 5px;">${periodInfo.className}</div>`;
                        }
                        displayName += `</div>`;
                    } else {
                        displayName += `<div style="background: #f0f9ff; color: #1976d2; padding: 15px; border-radius: 8px; margin-top: 10px; border-left: 4px solid #667eea;">`;
                        displayName += `<div style="font-size: 16px; font-weight: 600;">Outside Class Time</div>`;
                        displayName += `<div style="font-size: 14px; margin-top: 5px;">Not currently in a scheduled period</div>`;
                        displayName += `</div>`;
                    }
                }
            }
            
            // Restore previous school context
            passSettings.currentSchool = previousSchool;
            
            document.getElementById('kioskStudentName').innerHTML = displayName;
            document.getElementById('kioskStudentId').value = '';
            document.getElementById('passRequestForm').style.display = 'block';
        }

        function selectDestination(destination) {
            // Remove selection from all buttons
            document.querySelectorAll('.destination-btn').forEach(btn => {
                btn.style.transform = 'scale(1)';
                btn.style.border = 'none';
            });
            
            // Highlight selected button
            event.target.style.transform = 'scale(1.05)';
            event.target.style.border = '3px solid white';
            
            document.getElementById('selectedDestination').value = destination;
            document.getElementById('selectedDuration').value = passSettings[destination];
        }

        async function createHallPass() {
            // SYNC WITH CLOUD FIRST to get any new passes from other devices
            // This ensures we have the latest pass data before checking for conflicts
            console.log('🔄 Syncing with cloud before creating pass...');
            await loadData();
            console.log('✅ Cloud sync complete - checking for conflicts...');
            
            const destination = document.getElementById('selectedDestination').value;
            const duration = parseInt(document.getElementById('selectedDuration').value);
            const notes = document.getElementById('passNotes').value.trim();
            
            if (!destination) {
                alert('Please select a destination');
                return;
            }
            
            if (!selectedKioskStudent) {
                alert('Error: No student selected');
                return;
            }
            
            // Check if student has reached their daily pass limit
            if (selectedKioskStudent.dailyPassLimit && selectedKioskStudent.dailyPassLimit > 0) {
                const todayStart = new Date();
                todayStart.setHours(0, 0, 0, 0);
                const passesToday = hallPasses.filter(p => 
                    p.studentId === selectedKioskStudent.id && 
                    new Date(p.createdAt) >= todayStart
                ).length;
                
                if (passesToday >= selectedKioskStudent.dailyPassLimit) {
                    alert(`❌ Pass Limit Reached\n\nYou have reached your daily pass limit of ${selectedKioskStudent.dailyPassLimit} passes.\n\nPlease speak with your teacher or administrator.`);
                    return;
                }
            }
            
            // CHECK ENCOUNTER PREVENTION
            console.log('=== ENCOUNTER PREVENTION CHECK ===');
            console.log('Student ID:', selectedKioskStudent.id);
            console.log('Destination:', destination);
            console.log('Test Mode:', encounterTestMode);
            console.log('Prevention Groups:', preventionGroups);
            
            const encounterCheck = checkEncounterPrevention(selectedKioskStudent.id, destination);
            console.log('Encounter Check Result:', encounterCheck);
            
            if (encounterCheck && encounterCheck.blocked) {
                console.log('🚨 BLOCKING PASS!');
                alert(`❌ Pass Request Denied\n\nYou cannot create a pass to this location at this time.\n\nPlease see an administrator if you need assistance.`);
                return;
            }
            console.log('✅ Pass allowed - no blocking');
            
            const now = new Date();
            const expiresAt = new Date(now.getTime() + (duration * 60 * 1000));
            
            // DETECT SCHOOL FROM STUDENT GRADE (ClawPass only)
            const studentSchool = getSchoolFromGrade(selectedKioskStudent.grade);
            
            // Temporarily set school context for period detection
            const previousSchool = passSettings.currentSchool;
            passSettings.currentSchool = studentSchool;
            
            // AUTO-DETECT CURRENT PERIOD AND TEACHER (ClawPass only)
            let currentPeriodInfo = null;
            if (passSettings.enableAutoDetection) {
                currentPeriodInfo = detectCurrentPeriod(selectedKioskStudent, now);
            }
            
            // Restore previous school context
            passSettings.currentSchool = previousSchool;
            
            const hallPass = {
                id: 'pass_' + Date.now(),
                studentId: selectedKioskStudent.id,
                studentName: `${selectedKioskStudent.firstName} ${selectedKioskStudent.lastName}`,
                grade: selectedKioskStudent.grade,
                school: studentSchool, // Tag pass with school
                destination: destination,
                duration: duration,
                notes: notes,
                createdAt: now.toISOString(),
                expiresAt: expiresAt.toISOString(),
                status: 'active',
                returnedAt: null,
                // Period detection fields (ClawPass only)
                currentPeriod: currentPeriodInfo ? currentPeriodInfo.period : null,
                currentTeacher: currentPeriodInfo ? currentPeriodInfo.teacher : null,
                currentClass: currentPeriodInfo ? currentPeriodInfo.className : null,
                teacherId: currentPeriodInfo ? currentPeriodInfo.teacherId : null
            };
            
            hallPasses.push(hallPass);
            activeHallPasses.push(hallPass);
            
            await saveData();
            
            // Show pass confirmation
            showActivePass(hallPass);
            
            // Reset form
            cancelPassRequest();
        }

        // Detect current period and teacher based on schedule (ClawPass only)
        function detectCurrentPeriod(student, currentTime) {
            console.log('=== DETECT CURRENT PERIOD ===');
            console.log('Student:', student.firstName, student.lastName);
            console.log('Student ID:', student.id);
            console.log('Student object keys:', Object.keys(student));
            console.log('Student sections:', student.sections);
            console.log('Type of sections:', typeof student.sections);
            console.log('Is sections an array?:', Array.isArray(student.sections));
            
            // Get the active schedule (auto-detects day of week or uses manual override)
            const schedule = getActiveSchedule();
            console.log('Active schedule:', schedule);
            
            if (!schedule || !schedule.periods) {
                console.log('❌ No schedule or periods found');
                return null;
            }
            
            // Get current time in HH:MM format
            const hours = String(currentTime.getHours()).padStart(2, '0');
            const minutes = String(currentTime.getMinutes()).padStart(2, '0');
            const currentTimeStr = `${hours}:${minutes}`;
            console.log('Current time:', currentTimeStr);
            
            // Find which period it currently is
            let currentPeriod = null;
            for (const period of schedule.periods) {
                if (currentTimeStr >= period.start && currentTimeStr <= period.end) {
                    currentPeriod = period.period;
                    console.log('✅ Found current period:', currentPeriod, `(${period.start}-${period.end})`);
                    break;
                }
            }
            
            if (!currentPeriod) {
                // Not during a class period (before school, after school, between periods)
                console.log('❌ Not in any period - outside class time');
                return {
                    period: 'Outside Class Time',
                    teacher: null,
                    className: null,
                    teacherId: null
                };
            }
            
            // Look up which teacher the student has for this period
            // Student schedule is already loaded from PowerSchool CSV
            if (student.sections && student.sections.length > 0) {
                console.log('Student has', student.sections.length, 'sections');
                console.log('Looking for period:', currentPeriod);
                console.log('Available periods:', student.sections.map(s => s.period));
                
                const studentSection = student.sections.find(s => s.period === currentPeriod);
                
                if (studentSection) {
                    console.log('✅ Found matching section:', studentSection);
                    return {
                        period: currentPeriod,
                        teacher: studentSection.teacherName || null,
                        className: studentSection.courseName || null,
                        teacherId: studentSection.teacherId || null
                    };
                } else {
                    console.log('❌ No matching section found for period:', currentPeriod);
                }
            } else {
                console.log('❌ Student has no sections data');
            }
            
            // Period detected but no teacher found (student might not have this class)
            console.log('⚠️ Returning "No Class" - period found but no teacher');
            return {
                period: currentPeriod,
                teacher: 'No Class',
                className: null,
                teacherId: null
            };
        }

        function showActivePass(pass) {
            currentActivePass = pass; // Store reference to current pass
            const modal = document.getElementById('activePassModal');
            document.getElementById('passStudentName').textContent = pass.studentName;
            document.getElementById('passDestination').textContent = getDestinationDisplay(pass.destination);
            document.getElementById('passStartTime').textContent = new Date(pass.createdAt).toLocaleTimeString();
            
            // Show period and teacher info if available
            const periodInfoDiv = document.getElementById('passPeriodInfo');
            if (pass.currentPeriod && pass.currentPeriod !== 'Outside Class Time') {
                document.getElementById('passCurrentPeriod').textContent = pass.currentPeriod;
                document.getElementById('passCurrentTeacher').textContent = pass.currentTeacher || 'N/A';
                document.getElementById('passCurrentClass').textContent = pass.currentClass || 'N/A';
                periodInfoDiv.style.display = 'block';
            } else {
                periodInfoDiv.style.display = 'none';
            }
            
            // Start countdown timer
            startPassTimer(pass);
            
            document.getElementById('mainApp').classList.add('hidden');
            modal.classList.remove('hidden');
        }

        function startPassTimer(pass) {
            const timerDisplay = document.getElementById('passTimerDisplay');
            const expiresAt = new Date(pass.expiresAt);
            
            // Clear any existing timer
            if (currentPassTimer) {
                clearInterval(currentPassTimer);
            }
            
            currentPassTimer = setInterval(() => {
                const now = new Date();
                const remaining = expiresAt - now;
                
                if (remaining <= 0) {
                    clearInterval(currentPassTimer);
                    timerDisplay.textContent = '0:00';
                    timerDisplay.style.color = '#ef4444';
                    
                    // Auto-expire the pass
                    expirePass(pass.id);
                    return;
                }
                
                const minutes = Math.floor(remaining / 60000);
                const seconds = Math.floor((remaining % 60000) / 1000);
                timerDisplay.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
                
                // Change color when under 1 minute
                if (minutes === 0) {
                    timerDisplay.style.color = '#ffc107';
                }
            }, 1000);
        }

        async function closeActivePassModal() {
            // Mark pass as returned when student clicks "Done"
            if (currentActivePass) {
                const pass = hallPasses.find(p => p.id === currentActivePass.id);
                if (pass && pass.status === 'active') {
                    pass.status = 'returned';
                    pass.returnedAt = new Date().toISOString();
                    await saveData();
                    console.log('Pass marked as returned:', pass.id);
                }
                currentActivePass = null;
            }
            
            document.getElementById('activePassModal').classList.add('hidden');
            
            // Return to kiosk or main app depending on mode
            if (window.kioskOnlyMode) {
                // Return to kiosk
                document.getElementById('mainApp').classList.remove('hidden');
            } else {
                document.getElementById('mainApp').classList.remove('hidden');
            }
            
            if (currentPassTimer) {
                clearInterval(currentPassTimer);
                currentPassTimer = null;
            }
        }

        function cancelPassRequest() {
            selectedKioskStudent = null;
            document.getElementById('passRequestForm').style.display = 'none';
            document.getElementById('selectedDestination').value = '';
            document.getElementById('selectedDuration').value = '';
            document.getElementById('passNotes').value = '';
            
            // Reset destination button styles
            document.querySelectorAll('.destination-btn').forEach(btn => {
                btn.style.transform = 'scale(1)';
                btn.style.border = 'none';
            });
        }

        async function markPassReturned(passId) {
            const pass = hallPasses.find(p => p.id === passId);
            if (!pass) return;
            
            pass.status = 'returned';
            pass.returnedAt = new Date().toISOString();
            
            await saveData();
            updateHallMonitor();
            
            // Show brief confirmation
            const card = event.target.closest('div[style*="background: white"]');
            if (card) {
                card.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
                card.style.color = 'white';
                card.innerHTML = `
                    <div style="text-align: center; padding: 40px;">
                        <div style="font-size: 48px; margin-bottom: 15px;">✅</div>
                        <h3 style="margin: 0; color: white;">Pass Marked as Returned</h3>
                    </div>
                `;
                
                setTimeout(() => {
                    updateHallMonitor();
                }, 1500);
            }
        }

        function updateActivePassesDisplay() {
            // Update stats
            const now = new Date();
            const active = hallPasses.filter(p => p.status === 'active' && new Date(p.expiresAt) > now);
            const expiringSoon = active.filter(p => {
                const remaining = new Date(p.expiresAt) - now;
                return remaining < 2 * 60 * 1000; // Less than 2 minutes
            });
            const today = hallPasses.filter(p => {
                const created = new Date(p.createdAt);
                return created.toDateString() === now.toDateString();
            });
            
            document.getElementById('totalActivePasses').textContent = active.length;
            document.getElementById('expiringSoonPasses').textContent = expiringSoon.length;
            document.getElementById('todayTotalPasses').textContent = today.length;
            
            // Display active passes
            const grid = document.getElementById('activePassesGrid');
            grid.innerHTML = '';
            
            if (active.length === 0) {
                grid.innerHTML = '<p style="text-align: center; color: #999; padding: 40px; grid-column: 1/-1;">No active passes at this time</p>';
                return;
            }
            
            active.sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
            
            active.forEach(pass => {
                const card = createActivePassCard(pass);
                grid.appendChild(card);
            });
            
            // Auto-refresh every 5 seconds
            setTimeout(() => {
                if (document.getElementById('activePassesTab').style.display !== 'none') {
                    updateActivePassesDisplay();
                }
            }, 5000);
        }

        function createActivePassCard(pass) {
            const card = document.createElement('div');
            card.style.cssText = 'background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border-left: 5px solid #667eea;';
            
            const now = new Date();
            const remaining = new Date(pass.expiresAt) - now;
            const minutes = Math.floor(remaining / 60000);
            const seconds = Math.floor((remaining % 60000) / 1000);
            const timeColor = minutes === 0 ? '#ffc107' : '#10b981';
            
            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px;">
                    <div>
                        <h3 style="margin: 0 0 5px 0; color: #333;">${pass.studentName}</h3>
                        <div style="color: #999; font-size: 14px;">Grade ${pass.grade} • ID: ${pass.studentId}</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 24px; font-weight: 700; color: ${timeColor};">${minutes}:${seconds.toString().padStart(2, '0')}</div>
                        <div style="color: #999; font-size: 12px;">Remaining</div>
                    </div>
                </div>
                
                <div style="background: #f0f9ff; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                    <div style="display: grid; grid-template-columns: auto 1fr; gap: 10px; font-size: 14px;">
                        <strong>Destination:</strong>
                        <span>${getDestinationDisplay(pass.destination)}</span>
                        
                        <strong>Started:</strong>
                        <span>${new Date(pass.createdAt).toLocaleTimeString()}</span>
                        
                        <strong>Expires:</strong>
                        <span>${new Date(pass.expiresAt).toLocaleTimeString()}</span>
                        
                        ${pass.notes ? `<strong>Notes:</strong><span>${pass.notes}</span>` : ''}
                    </div>
                </div>
                
                <button onclick="returnPass('${pass.id}')" style="width: 100%; padding: 12px; background: #10b981; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">
                    ✅ Mark as Returned
                </button>
            `;
            
            return card;
        }

        function getDestinationDisplay(dest) {
            const map = {
                'bathroom': '🚻 Bathroom',
                'office': '🏢 Office',
                'classroom': '📚 Classroom',
                'wellness': '💚 Wellness Center'
            };
            return map[dest] || dest;
        }

        async function returnPass(passId) {
            const pass = hallPasses.find(p => p.id === passId);
            if (!pass) return;
            
            pass.status = 'returned';
            pass.returnedAt = new Date().toISOString();
            
            // Remove from active passes
            activeHallPasses = activeHallPasses.filter(p => p.id !== passId);
            
            await saveData();
            updateActivePassesDisplay();
        }

        async function expirePass(passId) {
            const pass = hallPasses.find(p => p.id === passId);
            if (!pass) return;
            
            // Only mark as overtime if not already returned
            if (pass.status === 'active') {
                pass.status = 'overtime';
                pass.expiredAt = new Date().toISOString();
                console.log('Pass marked as overtime:', pass.id);
            }
            
            // Remove from active passes
            activeHallPasses = activeHallPasses.filter(p => p.id !== passId);
            
            await saveData();
        }

        function updatePassHistory() {
            const searchTerm = document.getElementById('passHistorySearch').value.toLowerCase();
            const filterDest = document.getElementById('passHistoryFilter').value;
            
            let filtered = [...hallPasses].reverse(); // Most recent first
            
            if (searchTerm) {
                filtered = filtered.filter(p => 
                    p.studentName.toLowerCase().includes(searchTerm) ||
                    p.studentId.toLowerCase().includes(searchTerm)
                );
            }
            
            if (filterDest !== 'all') {
                filtered = filtered.filter(p => p.destination === filterDest);
            }
            
            const tbody = document.getElementById('passHistoryTable');
            tbody.innerHTML = '';
            
            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 40px; color: #999;">No passes found</td></tr>';
                return;
            }
            
            filtered.forEach(pass => {
                const row = document.createElement('tr');
                const statusColor = pass.status === 'returned' ? '#10b981' : 
                                   pass.status === 'overtime' ? '#ef4444' : 
                                   pass.status === 'active' ? '#4facfe' : '#ffc107';
                const statusText = pass.status === 'returned' ? '✅ Returned' :
                                  pass.status === 'overtime' ? '⏱️ Overtime' : 
                                  pass.status === 'active' ? '🟢 Active' : '⚠️ Expiring';
                
                row.innerHTML = `
                    <td>${new Date(pass.createdAt).toLocaleString()}</td>
                    <td>${pass.studentName}</td>
                    <td>${pass.grade}</td>
                    <td style="color: #667eea; font-weight: 600;">${pass.currentPeriod || '-'}</td>
                    <td>${pass.currentTeacher || '-'}</td>
                    <td style="font-size: 13px;">${pass.currentClass || '-'}</td>
                    <td>${getDestinationDisplay(pass.destination)}</td>
                    <td>${pass.duration} min</td>
                    <td style="color: ${statusColor}; font-weight: 600;">${statusText}</td>
                    <td>${pass.notes || '-'}</td>
                `;
                tbody.appendChild(row);
            });
        }

        function filterPassHistory() {
            updatePassHistory();
        }

        // Open Student Kiosk from login screen
        function openStudentKiosk() {
            // Hide login screen
            document.getElementById('loginScreen').classList.add('hidden');
            
            // Show main app
            document.getElementById('mainApp').classList.remove('hidden');
            
            // Hide ALL tabs - students don't need to see any tabs
            const tabsContainer = document.querySelector('.tabs');
            if (tabsContainer) tabsContainer.style.display = 'none';
            
            // Hide ALL tab content
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.style.display = 'none';
            });
            
            // Show ONLY the ClawPass content
            const clawPassContent = document.getElementById('clawPassContent');
            if (clawPassContent) {
                clawPassContent.style.display = 'block';
            }
            
            // Hide the ClawPass tabs ONLY for students (not admins/teachers)
            // Students should only see the kiosk view
            document.querySelectorAll('.subtab-button').forEach(btn => {
                btn.style.display = 'none';
            });
            
            // Hide all hall pass tabs first
            document.querySelectorAll('.hall-pass-tab').forEach(tab => {
                tab.style.display = 'none';
            });
            
            // Show ONLY the kiosk tab
            const kioskTab = document.getElementById('kioskTab');
            if (kioskTab) {
                kioskTab.style.display = 'block';
            }
            
            // Set body class for styling
            document.body.classList.remove('raffle-mode', 'cash-mode');
            document.body.classList.add('hallpass-mode');
            
            // Set a flag so we know we're in kiosk-only mode
            window.kioskOnlyMode = true;
            
            // Clear any previous kiosk data
            document.getElementById('kioskStudentId').value = '';
            document.getElementById('passRequestForm').style.display = 'none';
            
            // Add a "Back to Login" button to the kiosk
            addKioskBackButton();
        }

        function addKioskBackButton() {
            // Check if back button already exists
            if (document.getElementById('kioskBackButton')) return;
            
            const kioskTab = document.getElementById('kioskTab');
            if (!kioskTab) return;
            
            // Create back button
            const backButton = document.createElement('div');
            backButton.id = 'kioskBackButton';
            backButton.innerHTML = `
                <button class="btn btn-secondary" onclick="exitKioskMode()" style="position: fixed; top: 20px; left: 20px; z-index: 1000; padding: 12px 24px;">
                    ← Back to Login
                </button>
            `;
            kioskTab.insertBefore(backButton, kioskTab.firstChild);
        }

        function exitKioskMode() {
            // Clear kiosk flag
            window.kioskOnlyMode = false;
            
            // Remove back button
            const backButton = document.getElementById('kioskBackButton');
            if (backButton) backButton.remove();
            
            // Hide main app
            document.getElementById('mainApp').classList.add('hidden');
            
            // Show login screen
            document.getElementById('loginScreen').classList.remove('hidden');
            
            // Reset body classes
            document.body.classList.remove('hallpass-mode');
            
            // Clear any kiosk data
            document.getElementById('kioskStudentId').value = '';
            document.getElementById('passRequestForm').style.display = 'none';
            selectedKioskStudent = null;
        }

        // Update Hall Monitor display with real-time monitoring
        // Sync stat box highlighting when dropdown changes
        function syncStatBoxes() {
            const statusDropdown = document.getElementById('monitorStatusFilter');
            const currentFilter = statusDropdown.value;
            
            // Remove all selections
            document.getElementById('statBoxActive').classList.remove('selected');
            document.getElementById('statBoxExpiring').classList.remove('selected');
            document.getElementById('statBoxExpired').classList.remove('selected');
            document.getElementById('statBoxAll').classList.remove('selected');
            
            // Hide all checkmarks
            document.getElementById('checkActive').style.display = 'none';
            document.getElementById('checkExpiring').style.display = 'none';
            document.getElementById('checkExpired').style.display = 'none';
            document.getElementById('checkAll').style.display = 'none';
            
            // Highlight matching box
            if (currentFilter === 'active') {
                document.getElementById('statBoxActive').classList.add('selected');
                document.getElementById('checkActive').style.display = 'block';
            } else if (currentFilter === 'expiring') {
                document.getElementById('statBoxExpiring').classList.add('selected');
                document.getElementById('checkExpiring').style.display = 'block';
            } else if (currentFilter === 'expired') {
                document.getElementById('statBoxExpired').classList.add('selected');
                document.getElementById('checkExpired').style.display = 'block';
            } else if (currentFilter === 'all') {
                document.getElementById('statBoxAll').classList.add('selected');
                document.getElementById('checkAll').style.display = 'block';
            }
        }

        // Filter Hall Monitor by clicking stat boxes
        function filterByStatBox(filter) {
            const statusDropdown = document.getElementById('monitorStatusFilter');
            
            // Remove selection from all boxes
            document.getElementById('statBoxActive').classList.remove('selected');
            document.getElementById('statBoxExpiring').classList.remove('selected');
            document.getElementById('statBoxExpired').classList.remove('selected');
            document.getElementById('statBoxAll').classList.remove('selected');
            
            // Hide all checkmarks
            document.getElementById('checkActive').style.display = 'none';
            document.getElementById('checkExpiring').style.display = 'none';
            document.getElementById('checkExpired').style.display = 'none';
            document.getElementById('checkAll').style.display = 'none';
            
            // Set dropdown and highlight selected box
            if (filter === 'active') {
                statusDropdown.value = 'active';
                document.getElementById('statBoxActive').classList.add('selected');
                document.getElementById('checkActive').style.display = 'block';
            } else if (filter === 'expiring') {
                statusDropdown.value = 'expiring';
                document.getElementById('statBoxExpiring').classList.add('selected');
                document.getElementById('checkExpiring').style.display = 'block';
            } else if (filter === 'expired') {
                statusDropdown.value = 'expired';
                document.getElementById('statBoxExpired').classList.add('selected');
                document.getElementById('checkExpired').style.display = 'block';
            } else if (filter === 'all') {
                statusDropdown.value = 'all';
                document.getElementById('statBoxAll').classList.add('selected');
                document.getElementById('checkAll').style.display = 'block';
            }
            
            // Trigger filter update
            updateHallMonitor();
        }

        function updateHallMonitor() {
            try {
                const now = new Date();
                const searchTerm = document.getElementById('monitorSearch')?.value.toLowerCase() || '';
                const destFilter = document.getElementById('monitorDestinationFilter')?.value || 'all';
                const statusFilter = document.getElementById('monitorStatusFilter')?.value || 'active';
            
            // Get all passes and categorize them
            let allPasses = hallPasses.map(pass => {
                const createdTime = new Date(pass.createdAt);
                const expirationTime = new Date(createdTime.getTime() + pass.duration * 60000);
                const timeRemaining = (expirationTime - now) / 60000; // minutes
                
                let status;
                // Check pass.status first (returned or overtime)
                if (pass.status === 'returned') {
                    status = 'returned';
                } else if (pass.status === 'overtime') {
                    status = 'overtime';
                } else if (timeRemaining <= 0) {
                    status = 'overtime'; // Time expired but not marked yet
                } else if (timeRemaining <= 2) {
                    status = 'expiring';
                } else {
                    status = 'active';
                }
                
                return { ...pass, timeRemaining, currentStatus: status };
            });
            
            // FILTER BY SCHOOL - Only show passes from current school context
            allPasses = allPasses.filter(pass => {
                // If pass has no school tag, auto-detect from grade
                const passSchool = pass.school || getSchoolFromGrade(pass.grade);
                return passSchool === passSettings.currentSchool;
            });
            
            // AUTO-HIDE returned passes older than 2 minutes
            allPasses = allPasses.filter(pass => {
                if (pass.status === 'returned' && pass.returnedAt) {
                    const returnedTime = new Date(pass.returnedAt);
                    const minutesSinceReturn = (now - returnedTime) / 1000 / 60;
                    
                    // Hide if returned more than 2 minutes ago
                    if (minutesSinceReturn > 2) {
                        return false;
                    }
                }
                return true;
            });
            
            // Apply filters
            let filtered = allPasses;
            
            if (searchTerm) {
                filtered = filtered.filter(p => 
                    p.studentName.toLowerCase().includes(searchTerm) ||
                    p.studentId.toLowerCase().includes(searchTerm)
                );
            }
            
            if (destFilter !== 'all') {
                filtered = filtered.filter(p => p.destination === destFilter);
            }
            
            if (statusFilter === 'active') {
                filtered = filtered.filter(p => p.currentStatus === 'active' || p.currentStatus === 'expiring');
            } else if (statusFilter === 'expiring') {
                filtered = filtered.filter(p => p.currentStatus === 'expiring');
            } else if (statusFilter === 'expired') {
                filtered = filtered.filter(p => p.currentStatus === 'overtime');
            }
            // if 'all', don't filter by status
            
            // Update summary stats
            const activeCount = allPasses.filter(p => p.currentStatus === 'active' || p.currentStatus === 'expiring').length;
            const expiringCount = allPasses.filter(p => p.currentStatus === 'expiring').length;
            const overtimeCount = allPasses.filter(p => p.currentStatus === 'overtime').length;
            
            // Count today's passes
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayCount = allPasses.filter(p => new Date(p.createdAt) >= todayStart).length;
            
            // Update stats with null checks
            const totalActiveEl = document.getElementById('totalActivePasses');
            const expiringSoonEl = document.getElementById('expiringSoonPasses');
            const expiredEl = document.getElementById('expiredPasses');
            const todayTotalEl = document.getElementById('todayTotalPasses');
            
            if (totalActiveEl) totalActiveEl.textContent = activeCount;
            if (expiringSoonEl) expiringSoonEl.textContent = expiringCount;
            if (expiredEl) expiredEl.textContent = overtimeCount;
            if (todayTotalEl) todayTotalEl.textContent = todayCount;
            
            // Update passes grid
            const grid = document.getElementById('activePassesGrid');
            grid.innerHTML = '';
            
            if (filtered.length === 0) {
                grid.innerHTML = `
                    <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: #999; background: white; border-radius: 12px;">
                        <div style="font-size: 48px; margin-bottom: 15px;">🎫</div>
                        <p style="font-size: 18px; margin: 0;">No passes match your filters</p>
                    </div>
                `;
                return;
            }
            
            // Sort by time remaining (most urgent first)
            filtered.sort((a, b) => a.timeRemaining - b.timeRemaining);
            
            filtered.forEach(pass => {
                const card = document.createElement('div');
                
                // Determine color based on status
                let gradient, statusBadge, timerColor;
                if (pass.currentStatus === 'overtime') {
                    gradient = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
                    statusBadge = '⏱️ OVERTIME';
                    timerColor = '#ef4444';
                } else if (pass.currentStatus === 'expiring') {
                    gradient = 'linear-gradient(135deg, #ffd89b 0%, #f59e0b 100%)';
                    statusBadge = '⚠️ EXPIRING SOON';
                    timerColor = '#f59e0b';
                } else if (pass.currentStatus === 'returned') {
                    gradient = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
                    statusBadge = '✅ RETURNED';
                    timerColor = '#10b981';
                } else {
                    gradient = 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)';
                    statusBadge = '🟢 ACTIVE';
                    timerColor = '#4facfe';
                }
                
                const timeDisplay = pass.timeRemaining > 0 
                    ? `${Math.floor(pass.timeRemaining)} min remaining` 
                    : 'OVERTIME';
                
                card.innerHTML = `
                    <div style="background: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); border-left: 6px solid; border-left-color: ${timerColor};">
                        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 15px;">
                            <div>
                                <h3 style="margin: 0 0 5px 0; font-size: 20px; color: #333;">${pass.studentName}</h3>
                                <p style="margin: 0; color: #666; font-size: 14px;">ID: ${pass.studentId} | Grade ${pass.grade}</p>
                            </div>
                            <span style="padding: 6px 12px; background: ${gradient}; color: white; border-radius: 20px; font-size: 12px; font-weight: 600; white-space: nowrap;">
                                ${statusBadge}
                            </span>
                        </div>
                        
                        <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 14px;">
                                <div>
                                    <div style="color: #666; margin-bottom: 5px;">Destination</div>
                                    <div style="font-weight: 600; color: #333;">${getDestinationDisplay(pass.destination)}</div>
                                </div>
                                <div>
                                    <div style="color: #666; margin-bottom: 5px;">Duration</div>
                                    <div style="font-weight: 600; color: #333;">${pass.duration} minutes</div>
                                </div>
                                ${pass.currentPeriod ? `
                                <div>
                                    <div style="color: #666; margin-bottom: 5px;">From Period</div>
                                    <div style="font-weight: 600; color: #667eea;">${pass.currentPeriod}</div>
                                </div>
                                <div>
                                    <div style="color: #666; margin-bottom: 5px;">Teacher</div>
                                    <div style="font-weight: 600; color: #333;">${pass.currentTeacher || 'N/A'}</div>
                                </div>
                                ` : ''}
                                ${pass.currentClass ? `
                                <div style="grid-column: 1/-1;">
                                    <div style="color: #666; margin-bottom: 5px;">Class</div>
                                    <div style="font-weight: 600; color: #333;">${pass.currentClass}</div>
                                </div>
                                ` : ''}
                                <div>
                                    <div style="color: #666; margin-bottom: 5px;">Created</div>
                                    <div style="font-weight: 600; color: #333; font-size: 13px;">${new Date(pass.createdAt).toLocaleTimeString()}</div>
                                </div>
                                <div>
                                    <div style="color: #666; margin-bottom: 5px;">Time Left</div>
                                    <div style="font-weight: 700; color: ${timerColor}; font-size: 16px;">${timeDisplay}</div>
                                </div>
                            </div>
                        </div>
                        
                        ${pass.notes ? `<div style="padding: 10px; background: #fff3cd; border-radius: 6px; font-size: 13px; color: #856404; margin-bottom: 10px;">
                            <strong>Note:</strong> ${pass.notes}
                        </div>` : ''}
                        
                        ${pass.currentStatus !== 'returned' ? `
                            <button class="btn ${pass.currentStatus === 'overtime' ? 'btn-warning' : 'btn-success'}" onclick="markPassReturned('${pass.id}')" style="width: 100%; padding: 12px;">
                                ${pass.currentStatus === 'overtime' ? '⚠️ Mark Overtime Return' : '✅ Mark as Returned'}
                            </button>
                        ` : ''}
                    </div>
                `;
                
                grid.appendChild(card);
            });
            
            } catch (error) {
                console.error('ERROR in Hall Monitor:', error);
            }
        }

        async function savePassSettings() {
            passSettings.bathroom = parseInt(document.getElementById('bathroomDuration').value);
            passSettings.office = parseInt(document.getElementById('officeDuration').value);
            passSettings.classroom = parseInt(document.getElementById('classroomDuration').value);
            passSettings.wellness = parseInt(document.getElementById('wellnessDuration').value);
            
            await saveData();
            alert('✅ Pass settings saved successfully!');
        }

        // Update active schedule (ClawPass only)
        function updateActiveSchedule() {
            ensureBellSchedulesExist();
            
            const selectedSchedule = document.getElementById('activeScheduleSelect').value;
            passSettings.activeSchedule = selectedSchedule;
            saveData();
            
            if (selectedSchedule === 'auto') {
                const schedule = getActiveSchedule();
                console.log(`Auto-detect mode: Using ${schedule.name}`);
            } else {
                const scheduleName = passSettings.bellSchedules[selectedSchedule].name;
                console.log(`Manual override: Using ${scheduleName}`);
            }
        }

        // Toggle auto-detection (ClawPass only)
        function toggleAutoDetection() {
            const enabled = document.getElementById('enableAutoDetection').checked;
            passSettings.enableAutoDetection = enabled;
            saveData();
            
            if (enabled) {
                console.log('Period auto-detection enabled');
            } else {
                console.log('Period auto-detection disabled');
            }
        }

        // View schedule details (ClawPass only)
        function viewScheduleDetails() {
            const schedule = getActiveSchedule();
            
            if (!schedule) {
                alert('No schedule configured');
                return;
            }
            
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const today = days[new Date().getDay()];
            
            let scheduleText = `📅 ${schedule.name}\n`;
            scheduleText += `Today is: ${today}\n\n`;
            
            schedule.periods.forEach(period => {
                scheduleText += `${period.period}: ${period.start} - ${period.end}\n`;
            });
            
            alert(scheduleText);
        }

        // Ensure bell schedules exist (initialize with defaults if missing)
        function ensureBellSchedulesExist() {
            // Initialize bellSchedules object if it doesn't exist
            if (!passSettings.bellSchedules) {
                passSettings.bellSchedules = {};
            }
            
            // Initialize currentSchool if not set
            if (!passSettings.currentSchool) {
                passSettings.currentSchool = 'highschool';
            }
            
            // Check if we need to migrate from old schedule system to new multi-school system
            const hasOldSchedules = passSettings.bellSchedules.normal || passSettings.bellSchedules.mondayBlock1;
            const hasNewSchoolSchedules = passSettings.bellSchedules.hs_mondayBlock1 || passSettings.bellSchedules.ms_mondayBlock1;
            
            if (hasOldSchedules && !hasNewSchoolSchedules) {
                // Migration needed: Remove old schedules and add new HS/MS block schedules
                console.log('Migrating to multi-school schedule system...');
                
                // Keep custom schedules, remove old built-in ones
                const customSchedules = {};
                for (const key in passSettings.bellSchedules) {
                    if (passSettings.bellSchedules[key].isCustom) {
                        customSchedules[key] = passSettings.bellSchedules[key];
                    }
                }
                
                // Replace with new school-specific schedules
                passSettings.bellSchedules = customSchedules;
            }
            
            // CREATE HIGH SCHOOL SCHEDULES
            if (!passSettings.bellSchedules.hs_mondayBlock1) {
                passSettings.bellSchedules.hs_mondayBlock1 = {
                    name: "HS Monday - Block 1",
                    school: "highschool",
                    dayOfWeek: 1,
                    periods: [
                        { period: "A1", start: "07:45", end: "08:15" },
                        { period: "P1", start: "08:20", end: "09:50" },
                        { period: "P3", start: "09:55", end: "11:25" },
                        { period: "HPU", start: "11:30", end: "12:00" },
                        { period: "P5", start: "12:05", end: "13:35" },
                        { period: "A2", start: "13:40", end: "14:10" }
                    ]
                };
            }
            
            if (!passSettings.bellSchedules.hs_tuesdayBlock2) {
                passSettings.bellSchedules.hs_tuesdayBlock2 = {
                    name: "HS Tuesday - Block 2",
                    school: "highschool",
                    dayOfWeek: 2,
                    periods: [
                        { period: "A1", start: "07:45", end: "08:15" },
                        { period: "P2", start: "08:20", end: "09:50" },
                        { period: "P4", start: "09:55", end: "11:25" },
                        { period: "HPU", start: "11:30", end: "12:00" },
                        { period: "P6", start: "12:05", end: "13:35" },
                        { period: "A2", start: "13:40", end: "14:10" }
                    ]
                };
            }
            
            if (!passSettings.bellSchedules.hs_wednesdayAll) {
                passSettings.bellSchedules.hs_wednesdayAll = {
                    name: "HS Wednesday - All Periods",
                    school: "highschool",
                    dayOfWeek: 3,
                    periods: [
                        { period: "A1", start: "07:45", end: "08:15" },
                        { period: "P1", start: "08:20", end: "09:05" },
                        { period: "P2", start: "09:10", end: "09:55" },
                        { period: "P3", start: "10:00", end: "10:45" },
                        { period: "P4", start: "10:50", end: "11:35" },
                        { period: "HPU", start: "11:40", end: "12:10" },
                        { period: "P5", start: "12:15", end: "13:00" },
                        { period: "P6", start: "13:05", end: "13:50" },
                        { period: "A2", start: "13:55", end: "14:25" }
                    ]
                };
            }
            
            if (!passSettings.bellSchedules.hs_thursdayBlock1) {
                passSettings.bellSchedules.hs_thursdayBlock1 = {
                    name: "HS Thursday - Block 1",
                    school: "highschool",
                    dayOfWeek: 4,
                    periods: [
                        { period: "A1", start: "07:45", end: "08:15" },
                        { period: "P1", start: "08:20", end: "09:50" },
                        { period: "P3", start: "09:55", end: "11:25" },
                        { period: "HPU", start: "11:30", end: "12:00" },
                        { period: "P5", start: "12:05", end: "13:35" },
                        { period: "A2", start: "13:40", end: "14:10" }
                    ]
                };
            }
            
            if (!passSettings.bellSchedules.hs_fridayBlock2) {
                passSettings.bellSchedules.hs_fridayBlock2 = {
                    name: "HS Friday - Block 2",
                    school: "highschool",
                    dayOfWeek: 5,
                    periods: [
                        { period: "A1", start: "07:45", end: "08:15" },
                        { period: "P2", start: "08:20", end: "09:50" },
                        { period: "P4", start: "09:55", end: "11:25" },
                        { period: "HPU", start: "11:30", end: "12:00" },
                        { period: "P6", start: "12:05", end: "13:35" },
                        { period: "A2", start: "13:40", end: "14:10" }
                    ]
                };
            }
            
            // CREATE MIDDLE SCHOOL SCHEDULES (same structure, slightly different times)
            if (!passSettings.bellSchedules.ms_mondayBlock1) {
                passSettings.bellSchedules.ms_mondayBlock1 = {
                    name: "MS Monday - Block 1",
                    school: "middleschool",
                    dayOfWeek: 1,
                    periods: [
                        { period: "A1", start: "07:45", end: "08:15" },
                        { period: "P1", start: "08:20", end: "09:50" },
                        { period: "P3", start: "09:55", end: "11:25" },
                        { period: "HPU", start: "11:30", end: "12:00" },
                        { period: "P5", start: "12:05", end: "13:35" },
                        { period: "A2", start: "13:40", end: "14:10" }
                    ]
                };
            }
            
            if (!passSettings.bellSchedules.ms_tuesdayBlock2) {
                passSettings.bellSchedules.ms_tuesdayBlock2 = {
                    name: "MS Tuesday - Block 2",
                    school: "middleschool",
                    dayOfWeek: 2,
                    periods: [
                        { period: "A1", start: "07:45", end: "08:15" },
                        { period: "P2", start: "08:20", end: "09:50" },
                        { period: "P4", start: "09:55", end: "11:25" },
                        { period: "HPU", start: "11:30", end: "12:00" },
                        { period: "P6", start: "12:05", end: "13:35" },
                        { period: "A2", start: "13:40", end: "14:10" }
                    ]
                };
            }
            
            if (!passSettings.bellSchedules.ms_wednesdayAll) {
                passSettings.bellSchedules.ms_wednesdayAll = {
                    name: "MS Wednesday - All Periods",
                    school: "middleschool",
                    dayOfWeek: 3,
                    periods: [
                        { period: "A1", start: "07:45", end: "08:15" },
                        { period: "P1", start: "08:20", end: "09:05" },
                        { period: "P2", start: "09:10", end: "09:55" },
                        { period: "P3", start: "10:00", end: "10:45" },
                        { period: "P4", start: "10:50", end: "11:35" },
                        { period: "HPU", start: "11:40", end: "12:10" },
                        { period: "P5", start: "12:15", end: "13:00" },
                        { period: "P6", start: "13:05", end: "13:50" },
                        { period: "A2", start: "13:55", end: "14:25" }
                    ]
                };
            }
            
            if (!passSettings.bellSchedules.ms_thursdayBlock1) {
                passSettings.bellSchedules.ms_thursdayBlock1 = {
                    name: "MS Thursday - Block 1",
                    school: "middleschool",
                    dayOfWeek: 4,
                    periods: [
                        { period: "A1", start: "07:45", end: "08:15" },
                        { period: "P1", start: "08:20", end: "09:50" },
                        { period: "P3", start: "09:55", end: "11:25" },
                        { period: "HPU", start: "11:30", end: "12:00" },
                        { period: "P5", start: "12:05", end: "13:35" },
                        { period: "A2", start: "13:40", end: "14:10" }
                    ]
                };
            }
            
            if (!passSettings.bellSchedules.ms_fridayBlock2) {
                passSettings.bellSchedules.ms_fridayBlock2 = {
                    name: "MS Friday - Block 2",
                    school: "middleschool",
                    dayOfWeek: 5,
                    periods: [
                        { period: "A1", start: "07:45", end: "08:15" },
                        { period: "P2", start: "08:20", end: "09:50" },
                        { period: "P4", start: "09:55", end: "11:25" },
                        { period: "HPU", start: "11:30", end: "12:00" },
                        { period: "P6", start: "12:05", end: "13:35" },
                        { period: "A2", start: "13:40", end: "14:10" }
                    ]
                };
            }
            
            // SPECIAL SCHEDULES (shared or can be school-specific)
            if (!passSettings.bellSchedules.minimumDayBlock1) {
                passSettings.bellSchedules.minimumDayBlock1 = {
                    name: "Minimum Day - Block 1",
                    periods: [
                        { period: "A1", start: "07:45", end: "08:10" },
                        { period: "P1", start: "08:15", end: "09:15" },
                        { period: "P3", start: "09:20", end: "10:20" },
                        { period: "HPU", start: "10:25", end: "10:45" },
                        { period: "P5", start: "10:50", end: "11:50" },
                        { period: "A2", start: "11:55", end: "12:15" }
                    ]
                };
            }
            
            if (!passSettings.bellSchedules.minimumDayBlock2) {
                passSettings.bellSchedules.minimumDayBlock2 = {
                    name: "Minimum Day - Block 2",
                    periods: [
                        { period: "A1", start: "07:45", end: "08:10" },
                        { period: "P2", start: "08:15", end: "09:15" },
                        { period: "P4", start: "09:20", end: "10:20" },
                        { period: "HPU", start: "10:25", end: "10:45" },
                        { period: "P6", start: "10:50", end: "11:50" },
                        { period: "A2", start: "11:55", end: "12:15" }
                    ]
                };
            }
            
            if (!passSettings.bellSchedules.assembly) {
                passSettings.bellSchedules.assembly = {
                    name: "Assembly Schedule",
                    periods: [
                        { period: "A1", start: "07:45", end: "08:10" },
                        { period: "P1", start: "08:15", end: "08:45" },
                        { period: "P2", start: "08:50", end: "09:20" },
                        { period: "Assembly", start: "09:25", end: "10:25" },
                        { period: "P3", start: "10:30", end: "11:00" },
                        { period: "P4", start: "11:05", end: "11:35" },
                        { period: "HPU", start: "11:40", end: "12:10" },
                        { period: "P5", start: "12:15", end: "12:45" },
                        { period: "P6", start: "12:50", end: "13:20" },
                        { period: "A2", start: "13:25", end: "13:55" }
                    ]
                };
            }
            
            // Set default active schedule if not set
            if (!passSettings.activeSchedule) {
                passSettings.activeSchedule = 'auto';
            }
            
            // Set default auto-detection if not set
            if (passSettings.enableAutoDetection === undefined) {
                passSettings.enableAutoDetection = true;
            }
            
            // Save the updated schedules
            saveData();
        }

        // Get the correct schedule based on day of week or manual selection
        function getActiveSchedule() {
            ensureBellSchedulesExist();
            
            // If manual override is set (not 'auto'), use it
            if (passSettings.activeSchedule && passSettings.activeSchedule !== 'auto') {
                return passSettings.bellSchedules[passSettings.activeSchedule];
            }
            
            // Auto-detect based on day of week (0=Sunday, 1=Monday, ..., 6=Saturday)
            const today = new Date().getDay();
            
            // Determine which school's schedule to use based on current school setting
            const schoolPrefix = passSettings.currentSchool === 'middleschool' ? 'ms_' : 'hs_';
            
            // Map day of week to schedule
            const dayToSchedule = {
                1: schoolPrefix + 'mondayBlock1',      // Monday → Block 1
                2: schoolPrefix + 'tuesdayBlock2',      // Tuesday → Block 2
                3: schoolPrefix + 'wednesdayAll',       // Wednesday → All Periods
                4: schoolPrefix + 'thursdayBlock1',     // Thursday → Block 1
                5: schoolPrefix + 'fridayBlock2'        // Friday → Block 2
            };
            
            const scheduleName = dayToSchedule[today];
            
            // If it's a weekend or schedule not found, default to Wednesday (all periods)
            if (!scheduleName || !passSettings.bellSchedules[scheduleName]) {
                return passSettings.bellSchedules[schoolPrefix + 'wednesdayAll'] || passSettings.bellSchedules['hs_wednesdayAll'];
            }
            
            return passSettings.bellSchedules[scheduleName];
        }

        // Helper: Determine school from student grade
        function getSchoolFromGrade(grade) {
            const gradeNum = parseInt(grade);
            if (gradeNum >= 6 && gradeNum <= 8) {
                return 'middleschool';
            } else if (gradeNum >= 9 && gradeNum <= 12) {
                return 'highschool';
            }
            return 'highschool'; // default
        }

        // Switch between High School and Middle School
        async function switchSchool(school) {
            passSettings.currentSchool = school;
            await saveData();
            
            // Update UI cards in Hall Monitor
            const monitorHsCard = document.getElementById('monitorHsSchoolCard');
            const monitorMsCard = document.getElementById('monitorMsSchoolCard');
            
            if (monitorHsCard && monitorMsCard) {
                if (school === 'highschool') {
                    monitorHsCard.style.border = '3px solid #667eea';
                    monitorHsCard.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                    monitorHsCard.style.color = 'white';
                    
                    monitorMsCard.style.border = '3px solid #e0e0e0';
                    monitorMsCard.style.background = 'white';
                    monitorMsCard.style.color = '#666';
                } else {
                    monitorMsCard.style.border = '3px solid #10b981';
                    monitorMsCard.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
                    monitorMsCard.style.color = 'white';
                    
                    monitorHsCard.style.border = '3px solid #e0e0e0';
                    monitorHsCard.style.background = 'white';
                    monitorHsCard.style.color = '#666';
                }
            }
            
            // Update schedule dropdown options
            updateScheduleDropdownForSchool();
            
            // Refresh Hall Monitor to show only passes from selected school
            updateHallMonitor();
            
            alert(`✅ Switched to ${school === 'highschool' ? 'High School' : 'Middle School'}\n\nYou will now see only ${school === 'highschool' ? 'HS' : 'MS'} passes in Hall Monitor.`);
        }

        // Update schedule dropdown to show school-specific schedules
        function updateScheduleDropdownForSchool() {
            const select = document.getElementById('activeScheduleSelect');
            const schoolPrefix = passSettings.currentSchool === 'middleschool' ? 'MS' : 'HS';
            const prefix = passSettings.currentSchool === 'middleschool' ? 'ms_' : 'hs_';
            
            // Update block schedules optgroup
            const blockOptgroup = select.querySelector('optgroup[label*="Block Schedules"]');
            if (blockOptgroup) {
                blockOptgroup.innerHTML = `
                    <option value="${prefix}mondayBlock1">📅 ${schoolPrefix} Monday - Block 1</option>
                    <option value="${prefix}tuesdayBlock2">📅 ${schoolPrefix} Tuesday - Block 2</option>
                    <option value="${prefix}wednesdayAll">📅 ${schoolPrefix} Wednesday - All Periods</option>
                    <option value="${prefix}thursdayBlock1">📅 ${schoolPrefix} Thursday - Block 1</option>
                    <option value="${prefix}fridayBlock2">📅 ${schoolPrefix} Friday - Block 2</option>
                `;
            }
        }

        // Open Schedule Editor Modal
        function openScheduleEditor() {
            ensureBellSchedulesExist();
            console.log('Opening schedule editor...');
            console.log('Available schedules:', Object.keys(passSettings.bellSchedules));
            
            document.getElementById('scheduleEditorModal').classList.remove('hidden');
            document.getElementById('scheduleEditorSelect').value = 'hs_mondayBlock1';
            populateCustomSchedulesDropdown();
            loadScheduleForEditing();
        }

        // Close Schedule Editor Modal
        function closeScheduleEditor() {
            document.getElementById('scheduleEditorModal').classList.add('hidden');
        }

        // Populate custom schedules in dropdown
        function populateCustomSchedulesDropdown() {
            const optgroup = document.getElementById('customSchedulesOptgroup');
            if (!optgroup) return;
            
            // Clear existing custom schedules
            optgroup.innerHTML = '';
            
            // Add custom schedules
            const builtInSchedules = ['mondayBlock1', 'tuesdayBlock2', 'wednesdayAll', 'thursdayBlock1', 
                                       'fridayBlock2', 'minimumDayBlock1', 'minimumDayBlock2', 'assembly'];
            
            let hasCustomSchedules = false;
            for (const key in passSettings.bellSchedules) {
                if (!builtInSchedules.includes(key)) {
                    const schedule = passSettings.bellSchedules[key];
                    const option = document.createElement('option');
                    option.value = key;
                    option.textContent = `🎨 ${schedule.name}`;
                    optgroup.appendChild(option);
                    hasCustomSchedules = true;
                }
            }
            
            // Hide optgroup if no custom schedules
            if (!hasCustomSchedules) {
                optgroup.style.display = 'none';
            } else {
                optgroup.style.display = 'block';
            }
        }

        // Open Create Schedule Modal
        function openCreateScheduleModal() {
            document.getElementById('createScheduleModal').classList.remove('hidden');
            document.getElementById('newScheduleName').value = '';
            document.getElementById('copyFromSchedule').value = '';
            document.getElementById('numPeriods').value = 6;
        }

        // Close Create Schedule Modal
        function closeCreateScheduleModal() {
            document.getElementById('createScheduleModal').classList.add('hidden');
        }

        // Create new custom schedule
        async function createNewSchedule() {
            const scheduleName = document.getElementById('newScheduleName').value.trim();
            const copyFrom = document.getElementById('copyFromSchedule').value;
            const numPeriods = parseInt(document.getElementById('numPeriods').value);
            const scheduleSchool = document.getElementById('newScheduleSchool').value;
            
            if (!scheduleName) {
                alert('Please enter a schedule name');
                return;
            }
            
            if (numPeriods < 1 || numPeriods > 15) {
                alert('Number of periods must be between 1 and 15');
                return;
            }
            
            // Generate a unique key for the schedule
            const scheduleKey = 'custom_' + scheduleName.toLowerCase().replace(/[^a-z0-9]/g, '_');
            
            // Check if schedule already exists
            if (passSettings.bellSchedules[scheduleKey]) {
                alert('A schedule with this name already exists!');
                return;
            }
            
            let periods = [];
            
            if (copyFrom) {
                // Copy periods from existing schedule
                const sourceSchedule = passSettings.bellSchedules[copyFrom];
                if (sourceSchedule && sourceSchedule.periods) {
                    // Copy up to numPeriods
                    periods = sourceSchedule.periods.slice(0, numPeriods).map(p => ({...p}));
                    
                    // If we need more periods than source has, add blank ones
                    while (periods.length < numPeriods) {
                        periods.push({
                            period: `Period ${periods.length + 1}`,
                            start: "08:00",
                            end: "09:00"
                        });
                    }
                }
            } else {
                // Create blank periods
                for (let i = 0; i < numPeriods; i++) {
                    periods.push({
                        period: `Period ${i + 1}`,
                        start: "08:00",
                        end: "09:00"
                    });
                }
            }
            
            // Create the new schedule
            passSettings.bellSchedules[scheduleKey] = {
                name: scheduleName,
                periods: periods,
                isCustom: true,
                school: scheduleSchool // Save which school(s) can use this schedule
            };
            
            await saveData();
            
            closeCreateScheduleModal();
            
            // Refresh the editor dropdown and select the new schedule
            populateCustomSchedulesDropdown();
            document.getElementById('scheduleEditorSelect').value = scheduleKey;
            loadScheduleForEditing();
            
            alert(`✅ Custom schedule "${scheduleName}" created!\n\nNow edit the period times as needed.`);
        }

        // Delete custom schedule
        async function deleteCustomSchedule() {
            const scheduleName = document.getElementById('scheduleEditorSelect').value;
            const schedule = passSettings.bellSchedules[scheduleName];
            
            if (!schedule || !schedule.isCustom) {
                alert('Cannot delete built-in schedules');
                return;
            }
            
            const confirm = window.confirm(
                `⚠️ Delete Custom Schedule\n\n` +
                `Are you sure you want to delete "${schedule.name}"?\n\n` +
                `This action cannot be undone.`
            );
            
            if (!confirm) return;
            
            // Check if this schedule is currently active
            if (passSettings.activeSchedule === scheduleName) {
                passSettings.activeSchedule = 'auto';
            }
            
            // Delete the schedule
            delete passSettings.bellSchedules[scheduleName];
            
            await saveData();
            
            alert(`✅ Schedule "${schedule.name}" deleted!`);
            
            // Refresh dropdown and select a default schedule
            populateCustomSchedulesDropdown();
            document.getElementById('scheduleEditorSelect').value = 'mondayBlock1';
            loadScheduleForEditing();
        }

        // Load selected schedule into editor
        function loadScheduleForEditing() {
            const scheduleName = document.getElementById('scheduleEditorSelect').value;
            console.log('=== LOAD SCHEDULE FOR EDITING ===');
            console.log('Schedule name:', scheduleName);
            
            const schedule = passSettings.bellSchedules[scheduleName];
            console.log('Schedule object:', schedule);
            
            if (!schedule) {
                console.error('❌ Schedule not found:', scheduleName);
                alert('ERROR: Schedule not found! Check console.');
                return;
            }
            
            // Show/hide delete button based on if it's a custom schedule
            const deleteBtn = document.getElementById('deleteScheduleBtn');
            if (deleteBtn) {
                if (schedule.isCustom) {
                    deleteBtn.style.display = 'block';
                } else {
                    deleteBtn.style.display = 'none';
                }
            }
            
            const container = document.getElementById('periodEditorContainer');
            console.log('Container element:', container);
            
            if (!container) {
                console.error('❌ periodEditorContainer not found!');
                alert('ERROR: Container not found!');
                return;
            }
            
            console.log('Setting container innerHTML...');
            container.innerHTML = `<h4 style="margin-bottom: 15px; color: #667eea;">${schedule.name}</h4>`;
            
            console.log('Number of periods:', schedule.periods.length);
            
            schedule.periods.forEach((period, index) => {
                console.log(`Creating row for period ${index}:`, period);
                
                const periodRow = document.createElement('div');
                periodRow.style.cssText = 'display: grid; grid-template-columns: 120px 1fr 1fr; gap: 15px; align-items: center; margin-bottom: 15px; padding: 15px; background: white; border-radius: 8px; border: 2px solid green;';
                
                const html = `
                    <div>
                        <label style="display: block; margin-bottom: 5px; font-size: 12px; color: #666;">Period Name</label>
                        <input type="text" id="name_${scheduleName}_${index}" value="${period.period}" placeholder="e.g., P1, HPU, PT" style="width: 100%; padding: 8px; border: 2px solid #e0e0e0; border-radius: 6px; font-weight: 600;">
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 5px; font-size: 12px; color: #666;">Start Time</label>
                        <input type="time" id="start_${scheduleName}_${index}" value="${period.start}" style="width: 100%; padding: 8px; border: 2px solid #e0e0e0; border-radius: 6px; background: yellow;">
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 5px; font-size: 12px; color: #666;">End Time</label>
                        <input type="time" id="end_${scheduleName}_${index}" value="${period.end}" style="width: 100%; padding: 8px; border: 2px solid #e0e0e0; border-radius: 6px; background: yellow;">
                    </div>
                `;
                
                console.log(`HTML for period ${index}:`, html);
                periodRow.innerHTML = html;
                
                container.appendChild(periodRow);
                console.log(`✅ Added period ${index} to container`);
            });
            
            console.log('✅ Schedule editor loaded successfully');
            console.log('Container final HTML:', container.innerHTML);
        }

        // Save schedule edits
        async function saveScheduleEdits() {
            const scheduleName = document.getElementById('scheduleEditorSelect').value;
            const schedule = passSettings.bellSchedules[scheduleName];
            
            if (!schedule) return;
            
            // Update each period with new names and times
            schedule.periods.forEach((period, index) => {
                const nameInput = document.getElementById(`name_${scheduleName}_${index}`);
                const startInput = document.getElementById(`start_${scheduleName}_${index}`);
                const endInput = document.getElementById(`end_${scheduleName}_${index}`);
                
                if (nameInput) {
                    period.period = nameInput.value.trim() || `Period ${index + 1}`;
                }
                if (startInput && endInput) {
                    period.start = startInput.value;
                    period.end = endInput.value;
                }
            });
            
            await saveData();
            alert(`✅ ${schedule.name} saved successfully!`);
            closeScheduleEditor();
        }

        // Reset schedule to defaults
        function resetScheduleToDefaults() {
            const scheduleName = document.getElementById('scheduleEditorSelect').value;
            
            const confirm = window.confirm(
                '⚠️ Reset to Default Schedule\n\n' +
                'This will reset all period times to the default values.\n\n' +
                'Are you sure?'
            );
            
            if (!confirm) return;
            
            // Default schedules (these are just placeholders - you'll customize in the editor)
            const defaults = {
                mondayBlock1: [
                    { period: "A1", start: "07:45", end: "08:15" },
                    { period: "P1", start: "08:20", end: "09:50" },
                    { period: "P3", start: "09:55", end: "11:25" },
                    { period: "HPU", start: "11:30", end: "12:00" },
                    { period: "P5", start: "12:05", end: "13:35" },
                    { period: "A2", start: "13:40", end: "14:10" }
                ],
                tuesdayBlock2: [
                    { period: "A1", start: "07:45", end: "08:15" },
                    { period: "P2", start: "08:20", end: "09:50" },
                    { period: "P4", start: "09:55", end: "11:25" },
                    { period: "HPU", start: "11:30", end: "12:00" },
                    { period: "P6", start: "12:05", end: "13:35" },
                    { period: "A2", start: "13:40", end: "14:10" }
                ],
                wednesdayAll: [
                    { period: "A1", start: "07:45", end: "08:15" },
                    { period: "P1", start: "08:20", end: "09:05" },
                    { period: "P2", start: "09:10", end: "09:55" },
                    { period: "P3", start: "10:00", end: "10:45" },
                    { period: "P4", start: "10:50", end: "11:35" },
                    { period: "HPU", start: "11:40", end: "12:10" },
                    { period: "P5", start: "12:15", end: "13:00" },
                    { period: "P6", start: "13:05", end: "13:50" },
                    { period: "A2", start: "13:55", end: "14:25" }
                ],
                thursdayBlock1: [
                    { period: "A1", start: "07:45", end: "08:15" },
                    { period: "P1", start: "08:20", end: "09:50" },
                    { period: "P3", start: "09:55", end: "11:25" },
                    { period: "HPU", start: "11:30", end: "12:00" },
                    { period: "P5", start: "12:05", end: "13:35" },
                    { period: "A2", start: "13:40", end: "14:10" }
                ],
                fridayBlock2: [
                    { period: "A1", start: "07:45", end: "08:15" },
                    { period: "P2", start: "08:20", end: "09:50" },
                    { period: "P4", start: "09:55", end: "11:25" },
                    { period: "HPU", start: "11:30", end: "12:00" },
                    { period: "P6", start: "12:05", end: "13:35" },
                    { period: "A2", start: "13:40", end: "14:10" }
                ],
                minimumDayBlock1: [
                    { period: "A1", start: "07:45", end: "08:10" },
                    { period: "P1", start: "08:15", end: "09:15" },
                    { period: "P3", start: "09:20", end: "10:20" },
                    { period: "HPU", start: "10:25", end: "10:45" },
                    { period: "P5", start: "10:50", end: "11:50" },
                    { period: "A2", start: "11:55", end: "12:15" }
                ],
                minimumDayBlock2: [
                    { period: "A1", start: "07:45", end: "08:10" },
                    { period: "P2", start: "08:15", end: "09:15" },
                    { period: "P4", start: "09:20", end: "10:20" },
                    { period: "HPU", start: "10:25", end: "10:45" },
                    { period: "P6", start: "10:50", end: "11:50" },
                    { period: "A2", start: "11:55", end: "12:15" }
                ],
                assembly: [
                    { period: "A1", start: "07:45", end: "08:10" },
                    { period: "P1", start: "08:15", end: "08:45" },
                    { period: "P2", start: "08:50", end: "09:20" },
                    { period: "Assembly", start: "09:25", end: "10:25" },
                    { period: "P3", start: "10:30", end: "11:00" },
                    { period: "P4", start: "11:05", end: "11:35" },
                    { period: "HPU", start: "11:40", end: "12:10" },
                    { period: "P5", start: "12:15", end: "12:45" },
                    { period: "P6", start: "12:50", end: "13:20" },
                    { period: "A2", start: "13:25", end: "13:55" }
                ]
            };
            
            passSettings.bellSchedules[scheduleName].periods = defaults[scheduleName];
            saveData();
            loadScheduleForEditing();
            alert('✅ Schedule reset to defaults!');
        }

        // Initialize pass settings UI when switching to settings tab (ClawPass only)
        function initializePassSettingsUI() {
            // Ensure bell schedules exist first
            ensureBellSchedulesExist();
            
            // Update schedule dropdown for current school
            updateScheduleDropdownForSchool();
            
            // Set duration values
            document.getElementById('bathroomDuration').value = passSettings.bathroom;
            document.getElementById('officeDuration').value = passSettings.office;
            document.getElementById('classroomDuration').value = passSettings.classroom;
            document.getElementById('wellnessDuration').value = passSettings.wellness;
            
            // Populate custom schedules in Pass Settings dropdown
            const optgroupSettings = document.getElementById('customSchedulesOptgroupSettings');
            if (optgroupSettings) {
                optgroupSettings.innerHTML = '';
                const builtInSchedules = ['hs_mondayBlock1', 'hs_tuesdayBlock2', 'hs_wednesdayAll', 'hs_thursdayBlock1', 
                                           'hs_fridayBlock2', 'ms_mondayBlock1', 'ms_tuesdayBlock2', 'ms_wednesdayAll',
                                           'ms_thursdayBlock1', 'ms_fridayBlock2', 'minimumDayBlock1', 'minimumDayBlock2', 'assembly'];
                
                let hasCustomSchedules = false;
                for (const key in passSettings.bellSchedules) {
                    if (!builtInSchedules.includes(key)) {
                        const schedule = passSettings.bellSchedules[key];
                        const option = document.createElement('option');
                        option.value = key;
                        option.textContent = `🎨 ${schedule.name}`;
                        optgroupSettings.appendChild(option);
                        hasCustomSchedules = true;
                    }
                }
                
                if (!hasCustomSchedules) {
                    optgroupSettings.style.display = 'none';
                } else {
                    optgroupSettings.style.display = 'block';
                }
            }
            
            // Set schedule values
            document.getElementById('activeScheduleSelect').value = passSettings.activeSchedule || 'auto';
            document.getElementById('enableAutoDetection').checked = passSettings.enableAutoDetection !== false;
        }

        // ============================================
        // STUDENT SNAPSHOT FUNCTIONS
        // ============================================
        
        let selectedSnapshotStudent = null;
        let snapshotPeriod = 'today';
        let snapshotSearchSelectedIndex = -1;
        let snapshotSearchResults = [];
        
        // Show search results as you type
        function showSnapshotSearchResults() {
            const searchTerm = document.getElementById('snapshotStudentSearch').value.toLowerCase().trim();
            const resultsDiv = document.getElementById('snapshotSearchResults');
            
            if (!searchTerm) {
                resultsDiv.style.display = 'none';
                snapshotSearchResults = [];
                snapshotSearchSelectedIndex = -1;
                return;
            }
            
            // Filter students
            snapshotSearchResults = students.filter(student => {
                const fullName = `${student.firstName} ${student.lastName}`.toLowerCase();
                const reverseName = `${student.lastName} ${student.firstName}`.toLowerCase();
                const id = student.id.toLowerCase();
                
                return fullName.includes(searchTerm) || 
                       reverseName.includes(searchTerm) || 
                       id.includes(searchTerm);
            }).sort((a, b) => a.lastName.localeCompare(b.lastName));
            
            // Show results
            if (snapshotSearchResults.length === 0) {
                resultsDiv.innerHTML = '<div style="padding: 15px; color: #999; text-align: center;">No students found</div>';
                resultsDiv.style.display = 'block';
                return;
            }
            
            // Limit to 10 results
            const displayResults = snapshotSearchResults.slice(0, 10);
            resultsDiv.innerHTML = '';
            
            displayResults.forEach((student, index) => {
                const div = document.createElement('div');
                div.style.padding = '12px 15px';
                div.style.cursor = 'pointer';
                div.style.borderBottom = '1px solid #f0f0f0';
                div.style.transition = 'background 0.2s';
                div.innerHTML = `
                    <div style="font-weight: 600; color: #333;">${student.firstName} ${student.lastName}</div>
                    <div style="font-size: 13px; color: #666;">ID: ${student.id} | Grade ${student.grade}</div>
                `;
                
                div.onmouseover = () => {
                    div.style.background = '#f0f4ff';
                    snapshotSearchSelectedIndex = index;
                    updateSnapshotSearchHighlight();
                };
                div.onmouseout = () => {
                    div.style.background = 'white';
                };
                div.onclick = () => {
                    selectSnapshotStudent(student);
                };
                
                resultsDiv.appendChild(div);
            });
            
            if (snapshotSearchResults.length > 10) {
                const moreDiv = document.createElement('div');
                moreDiv.style.padding = '10px 15px';
                moreDiv.style.background = '#f9f9f9';
                moreDiv.style.color = '#666';
                moreDiv.style.fontSize = '13px';
                moreDiv.style.textAlign = 'center';
                moreDiv.textContent = `+ ${snapshotSearchResults.length - 10} more results (keep typing to narrow down)`;
                resultsDiv.appendChild(moreDiv);
            }
            
            resultsDiv.style.display = 'block';
            snapshotSearchSelectedIndex = -1;
        }
        
        // Handle keyboard navigation
        function handleSnapshotSearchKeys(event) {
            const resultsDiv = document.getElementById('snapshotSearchResults');
            if (resultsDiv.style.display === 'none' || snapshotSearchResults.length === 0) return;
            
            const displayCount = Math.min(snapshotSearchResults.length, 10);
            
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                snapshotSearchSelectedIndex = Math.min(snapshotSearchSelectedIndex + 1, displayCount - 1);
                updateSnapshotSearchHighlight();
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                snapshotSearchSelectedIndex = Math.max(snapshotSearchSelectedIndex - 1, -1);
                updateSnapshotSearchHighlight();
            } else if (event.key === 'Enter') {
                event.preventDefault();
                if (snapshotSearchSelectedIndex >= 0 && snapshotSearchSelectedIndex < snapshotSearchResults.length) {
                    selectSnapshotStudent(snapshotSearchResults[snapshotSearchSelectedIndex]);
                } else if (snapshotSearchResults.length === 1) {
                    selectSnapshotStudent(snapshotSearchResults[0]);
                }
            } else if (event.key === 'Escape') {
                resultsDiv.style.display = 'none';
            }
        }
        
        // Update visual highlight for keyboard navigation
        function updateSnapshotSearchHighlight() {
            const resultsDiv = document.getElementById('snapshotSearchResults');
            const items = resultsDiv.querySelectorAll('div[style*="cursor: pointer"]');
            
            items.forEach((item, index) => {
                if (index === snapshotSearchSelectedIndex) {
                    item.style.background = '#e3f2fd';
                    item.style.borderLeft = '4px solid #667eea';
                } else {
                    item.style.background = 'white';
                    item.style.borderLeft = 'none';
                }
            });
        }
        
        // Select a student and load their snapshot
        function selectSnapshotStudent(student) {
            selectedSnapshotStudent = student;
            document.getElementById('snapshotStudentSearch').value = `${student.firstName} ${student.lastName} (${student.id})`;
            document.getElementById('snapshotSearchResults').style.display = 'none';
            loadStudentSnapshot();
        }
        
        // Initialize (no longer needed but keeping for compatibility)
        function initializeSnapshotStudents() {
            // Not needed anymore - search is dynamic
        }
        
        // Filter (no longer needed but keeping for compatibility)
        function filterSnapshotStudents() {
            // Not needed anymore - using showSnapshotSearchResults instead
        }
        
        // Load student snapshot
        function loadStudentSnapshot() {
            if (!selectedSnapshotStudent) {
                document.getElementById('snapshotContent').style.display = 'none';
                return;
            }
            
            // Show snapshot content
            document.getElementById('snapshotContent').style.display = 'block';
            
            // Update header
            document.getElementById('snapshotStudentName').textContent = 
                `${selectedSnapshotStudent.firstName} ${selectedSnapshotStudent.lastName}`;
            document.getElementById('snapshotStudentId').textContent = selectedSnapshotStudent.id;
            document.getElementById('snapshotStudentGrade').textContent = selectedSnapshotStudent.grade;
            
            // Detect current class
            const currentPeriodInfo = detectCurrentPeriod(selectedSnapshotStudent, new Date());
            if (currentPeriodInfo && currentPeriodInfo.period !== 'Outside Class Time') {
                document.getElementById('snapshotCurrentClass').innerHTML = 
                    `📍 Currently in: <strong>${currentPeriodInfo.period} - ${currentPeriodInfo.teacher || 'N/A'} (${currentPeriodInfo.className || 'N/A'})</strong>`;
            } else {
                document.getElementById('snapshotCurrentClass').innerHTML = 
                    `📍 Currently: <strong>Outside Class Time</strong>`;
            }
            
            // Update snapshot data
            updateSnapshotData();
        }
        
        // Set time period filter
        function setSnapshotPeriod(period) {
            snapshotPeriod = period;
            
            // Update button styles
            ['today', 'week', 'month', 'year'].forEach(p => {
                const btn = document.getElementById('snapshot' + p.charAt(0).toUpperCase() + p.slice(1));
                if (p === period) {
                    btn.className = 'btn';
                    btn.style.background = '#667eea';
                    btn.style.color = 'white';
                } else {
                    btn.className = 'btn btn-secondary';
                    btn.style.background = '';
                    btn.style.color = '';
                }
            });
            
            updateSnapshotData();
        }
        
        // Update all snapshot data
        function updateSnapshotData() {
            if (!selectedSnapshotStudent) return;
            
            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            const yearStart = new Date(now.getFullYear(), 7, 1); // Aug 1st (school year start)
            
            // Get student's passes
            const studentPasses = hallPasses.filter(p => p.studentId === selectedSnapshotStudent.id);
            
            // Calculate stats for different periods
            const passesToday = studentPasses.filter(p => new Date(p.createdAt) >= todayStart).length;
            const passesWeek = studentPasses.filter(p => new Date(p.createdAt) >= weekStart).length;
            const passesMonth = studentPasses.filter(p => new Date(p.createdAt) >= monthStart).length;
            
            // Get passes for selected period
            let periodPasses;
            switch(snapshotPeriod) {
                case 'today':
                    periodPasses = studentPasses.filter(p => new Date(p.createdAt) >= todayStart);
                    break;
                case 'week':
                    periodPasses = studentPasses.filter(p => new Date(p.createdAt) >= weekStart);
                    break;
                case 'month':
                    periodPasses = studentPasses.filter(p => new Date(p.createdAt) >= monthStart);
                    break;
                case 'year':
                    periodPasses = studentPasses.filter(p => new Date(p.createdAt) >= yearStart);
                    break;
            }
            
            // Calculate total time and overtime
            let totalTime = 0;
            let overtimeCount = 0;
            periodPasses.forEach(pass => {
                totalTime += pass.duration;
                if (pass.status === 'overtime') overtimeCount++;
            });
            
            // Update summary stats
            document.getElementById('snapshotPassesToday').textContent = passesToday;
            document.getElementById('snapshotPassesWeek').textContent = passesWeek;
            document.getElementById('snapshotPassesMonth').textContent = passesMonth;
            document.getElementById('snapshotTotalTime').textContent = totalTime;
            document.getElementById('snapshotOvertime').textContent = overtimeCount;
            
            // Check pass limit
            updatePassLimitStatus();
            
            // Update per-period breakdown
            updatePeriodBreakdown(periodPasses);
        }
        
        // Update pass limit status
        function updatePassLimitStatus() {
            if (!selectedSnapshotStudent) return;
            
            const passLimit = selectedSnapshotStudent.dailyPassLimit || 0;
            
            if (passLimit > 0) {
                const todayStart = new Date();
                todayStart.setHours(0, 0, 0, 0);
                const passesToday = hallPasses.filter(p => 
                    p.studentId === selectedSnapshotStudent.id && 
                    new Date(p.createdAt) >= todayStart
                ).length;
                
                document.getElementById('passLimitStatus').style.display = 'block';
                document.getElementById('passLimitCurrent').textContent = passesToday;
                document.getElementById('passLimitMax').textContent = passLimit;
                
                // Change color if over limit
                if (passesToday >= passLimit) {
                    document.getElementById('passLimitStatus').style.background = '#fee2e2';
                    document.getElementById('passLimitStatus').style.borderLeftColor = '#ef4444';
                } else {
                    document.getElementById('passLimitStatus').style.background = '#fff3cd';
                    document.getElementById('passLimitStatus').style.borderLeftColor = '#ffc107';
                }
            } else {
                document.getElementById('passLimitStatus').style.display = 'none';
            }
        }
        
        // Update per-period breakdown
        function updatePeriodBreakdown(passes) {
            const tbody = document.getElementById('snapshotPeriodBreakdown');
            tbody.innerHTML = '';
            
            if (!selectedSnapshotStudent.sections || selectedSnapshotStudent.sections.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: #999;">No class schedule data available</td></tr>';
                return;
            }
            
            // Group passes by period
            const periodStats = {};
            
            passes.forEach(pass => {
                const period = pass.currentPeriod || 'Unknown';
                if (!periodStats[period]) {
                    periodStats[period] = {
                        passes: 0,
                        timeMissed: 0,
                        overtime: 0
                    };
                }
                periodStats[period].passes++;
                periodStats[period].timeMissed += pass.duration;
                if (pass.status === 'overtime') periodStats[period].overtime++;
            });
            
            // Show each class period
            selectedSnapshotStudent.sections.forEach(section => {
                const stats = periodStats[section.period] || { passes: 0, timeMissed: 0, overtime: 0 };
                
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td style="font-weight: 600; color: #667eea;">${section.period}</td>
                    <td>${section.courseName || 'N/A'}</td>
                    <td>${section.teacherName || 'N/A'}</td>
                    <td style="text-align: center;">${stats.passes}</td>
                    <td style="text-align: center; font-weight: 600;">${stats.timeMissed}</td>
                    <td style="text-align: center; color: ${stats.overtime > 0 ? '#ef4444' : '#10b981'};">${stats.overtime}</td>
                `;
                tbody.appendChild(row);
            });
            
            if (selectedSnapshotStudent.sections.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: #999;">No class periods found</td></tr>';
            }
        }
        
        // Open pass limit modal
        function openPassLimitModal() {
            if (!selectedSnapshotStudent) return;
            
            document.getElementById('passLimitStudentName').textContent = 
                `${selectedSnapshotStudent.firstName} ${selectedSnapshotStudent.lastName}`;
            document.getElementById('passLimitInput').value = selectedSnapshotStudent.dailyPassLimit || 0;
            document.getElementById('passLimitModal').classList.remove('hidden');
        }
        
        // Close pass limit modal
        function closePassLimitModal() {
            document.getElementById('passLimitModal').classList.add('hidden');
        }
        
        // Save pass limit
        async function savePassLimit() {
            if (!selectedSnapshotStudent) return;
            
            const limit = parseInt(document.getElementById('passLimitInput').value);
            
            if (limit < 0) {
                alert('Pass limit cannot be negative');
                return;
            }
            
            selectedSnapshotStudent.dailyPassLimit = limit;
            await saveData();
            
            closePassLimitModal();
            updatePassLimitStatus();
            
            if (limit === 0) {
                alert(`✅ Pass limit removed for ${selectedSnapshotStudent.firstName} ${selectedSnapshotStudent.lastName}`);
            } else {
                alert(`✅ Daily pass limit set to ${limit} for ${selectedSnapshotStudent.firstName} ${selectedSnapshotStudent.lastName}`);
            }
        }

        // ============================================
        // CLAWPASS DATA RESET FUNCTIONS
        // ============================================
        
        function confirmClawPassReset() {
            // Show pass count in modal
            document.getElementById('resetPassCount').textContent = hallPasses.length;
            
            // Clear confirmation input
            document.getElementById('resetConfirmationInput').value = '';
            
            // Show modal
            document.getElementById('clawPassResetModal').classList.remove('hidden');
        }
        
        function closeClawPassResetModal() {
            document.getElementById('clawPassResetModal').classList.add('hidden');
            document.getElementById('resetConfirmationInput').value = '';
        }
        
        async function executeClawPassReset() {
            const confirmation = document.getElementById('resetConfirmationInput').value;
            
            // Check confirmation
            if (confirmation !== 'DELETE') {
                alert('❌ Incorrect confirmation.\n\nPlease type DELETE (in all caps) to proceed.');
                return;
            }
            
            // Double-check with native confirm dialog
            const finalConfirm = confirm(
                `⚠️ FINAL WARNING ⚠️\n\n` +
                `You are about to PERMANENTLY DELETE:\n` +
                `• ${hallPasses.length} hall passes\n` +
                `• All pass limits\n` +
                `• All ClawPass statistics\n\n` +
                `This CANNOT be undone!\n\n` +
                `Click OK to proceed, or Cancel to abort.`
            );
            
            if (!finalConfirm) {
                closeClawPassResetModal();
                return;
            }
            
            // Perform the reset
            try {
                console.log('🗑️ Starting ClawPass data reset...');
                console.log('Deleting', hallPasses.length, 'hall passes');
                
                // Clear all hall passes
                hallPasses = [];
                
                // Remove daily pass limits from all students
                students.forEach(student => {
                    if (student.dailyPassLimit) {
                        delete student.dailyPassLimit;
                    }
                });
                
                console.log('✅ ClawPass data reset complete');
                
                // Save to database
                await saveData();
                
                // Close modal
                closeClawPassResetModal();
                
                // Refresh displays
                updateHallMonitor();
                updatePassHistory();
                
                // Success message
                alert(
                    `✅ ClawPass Data Reset Complete!\n\n` +
                    `All hall pass data has been permanently deleted.\n\n` +
                    `• Hall passes: Cleared\n` +
                    `• Pass limits: Removed\n` +
                    `• Statistics: Reset\n\n` +
                    `All other data (students, tickets, cash) remains intact.`
                );
                
            } catch (error) {
                console.error('Error resetting ClawPass data:', error);
                alert('❌ Error resetting data. Please try again or contact support.');
            }
        }

        // ============================================
        // ENCOUNTER PREVENTION SYSTEM
        // ============================================
        
        // Global state
        let encounterTestMode = true; // Start in test mode by default
        let preventionGroups = [];
        let detectedPatterns = [];
        let encounterGroupToEdit = null;
        let groupStudents = [];
        
        // Switch encounter prevention subtabs
        function switchEncounterTab(tabName) {
            document.querySelectorAll('.encounter-subtab').forEach(btn => {
                btn.style.background = '#f5f5f5';
                btn.style.color = '#333';
            });
            document.querySelectorAll('.encounter-subtab-content').forEach(content => {
                content.style.display = 'none';
            });
            
            const btnId = tabName === 'patterns' ? 'patternsSubtabBtn' :
                          tabName === 'groups' ? 'groupsSubtabBtn' : 'testSubtabBtn';
            const contentId = tabName + 'Subtab';
            
            document.getElementById(btnId).style.background = '#667eea';
            document.getElementById(btnId).style.color = 'white';
            document.getElementById(contentId).style.display = 'block';
            
            // Load data for the tab
            if (tabName === 'patterns') {
                analyzeEncounterPatterns();
            } else if (tabName === 'groups') {
                updatePreventionGroupsDisplay();
            }
        }
        
        // Toggle test mode
        function toggleEncounterTestMode() {
            if (encounterTestMode) {
                // Switching to live mode
                const confirm = window.confirm(
                    '⚠️ Switch to Live Mode?\n\n' +
                    'This will:\n' +
                    '• Use real student data for pattern detection\n' +
                    '• Enable actual pass blocking (if prevention groups are active)\n' +
                    '• Clear all test data\n\n' +
                    'Are you sure?'
                );
                
                if (!confirm) return;
                
                encounterTestMode = false;
                clearTestData();
                document.getElementById('testModeBanner').style.display = 'none';
                document.getElementById('currentModeDisplay').textContent = '🔴 Live Mode';
                document.getElementById('modeToggleBtn').textContent = '🧪 Switch to Test Mode';
                document.getElementById('modeToggleBtn').style.background = '#3b82f6';
                
                alert('✅ Switched to Live Mode\n\nThe system is now using real student data.');
            } else {
                // Switching to test mode
                encounterTestMode = true;
                document.getElementById('testModeBanner').style.display = 'block';
                document.getElementById('currentModeDisplay').textContent = '🧪 Test Mode';
                document.getElementById('modeToggleBtn').textContent = '🔴 Switch to Live Mode';
                document.getElementById('modeToggleBtn').style.background = '#dc2626';
                
                alert('✅ Switched to Test Mode\n\nYou can now safely test with simulated data.');
            }
            
            analyzeEncounterPatterns();
        }
        
        // Generate random test data
        function generateTestData() {
            const testStudents = [];
            const testPasses = [];
            
            // Create 10 test students with all required fields
            for (let i = 1; i <= 10; i++) {
                testStudents.push({
                    id: `TEST${1000 + i}`,
                    firstName: `TestStudent${String.fromCharCode(64 + i)}`,
                    lastName: 'Test',
                    grade: `${Math.floor(Math.random() * 4) + 9}`, // Grades 9-12 as strings
                    pbisTickets: 0,
                    attendanceTickets: 0,
                    academicTickets: 0,
                    bigRaffleQualified: false,
                    weeksQualified: 0,
                    ticketHistory: [],
                    wildcatCashBalance: 0,
                    wildcatCashEarned: 0,
                    wildcatCashSpent: 0,
                    wildcatCashDeducted: 0,
                    wildcatCashTransactions: [],
                    wildcatCashRewardsRedeemed: [],
                    sections: [], // Empty schedule for test students
                    isTestData: true
                });
            }
            
            // Add test students to main array
            students.push(...testStudents);
            
            // Generate 50 passes with patterns
            const now = new Date();
            const destinations = ['bathroom', 'office', 'wellness', 'classroom'];
            
            // Create suspicious pair: Student A & B (7 bathroom overlaps)
            for (let i = 0; i < 7; i++) {
                const date = new Date(now.getTime() - (i * 2 * 24 * 60 * 60 * 1000)); // Every 2 days
                const baseTime = new Date(date);
                baseTime.setHours(14, 10 + i, 0, 0);
                
                hallPasses.push({
                    id: `testpass_${Date.now()}_${i}_a`,
                    studentId: testStudents[0].id,
                    studentName: `${testStudents[0].firstName} ${testStudents[0].lastName}`,
                    grade: testStudents[0].grade,
                    destination: 'bathroom',
                    duration: 5,
                    createdAt: baseTime.toISOString(),
                    status: 'returned',
                    returnedAt: new Date(baseTime.getTime() + 5 * 60000).toISOString(),
                    school: 'highschool',
                    isTestData: true
                });
                
                // Second student 2 minutes later
                const time2 = new Date(baseTime.getTime() + 2 * 60000);
                hallPasses.push({
                    id: `testpass_${Date.now()}_${i}_b`,
                    studentId: testStudents[1].id,
                    studentName: `${testStudents[1].firstName} ${testStudents[1].lastName}`,
                    grade: testStudents[1].grade,
                    destination: 'bathroom',
                    duration: 5,
                    createdAt: time2.toISOString(),
                    status: 'returned',
                    returnedAt: new Date(time2.getTime() + 5 * 60000).toISOString(),
                    school: 'highschool',
                    isTestData: true
                });
            }
            
            // Create medium suspicion pair: Student C & D (4 overlaps, mixed locations)
            for (let i = 0; i < 4; i++) {
                const date = new Date(now.getTime() - (i * 3 * 24 * 60 * 60 * 1000));
                const baseTime = new Date(date);
                baseTime.setHours(13, 30 + i * 5, 0, 0);
                const dest = i % 2 === 0 ? 'bathroom' : 'wellness';
                
                hallPasses.push({
                    id: `testpass_${Date.now()}_med_${i}_a`,
                    studentId: testStudents[2].id,
                    studentName: `${testStudents[2].firstName} ${testStudents[2].lastName}`,
                    grade: testStudents[2].grade,
                    destination: dest,
                    duration: 10,
                    createdAt: baseTime.toISOString(),
                    status: 'returned',
                    returnedAt: new Date(baseTime.getTime() + 10 * 60000).toISOString(),
                    school: 'highschool',
                    isTestData: true
                });
                
                const time2 = new Date(baseTime.getTime() + 4 * 60000);
                hallPasses.push({
                    id: `testpass_${Date.now()}_med_${i}_b`,
                    studentId: testStudents[3].id,
                    studentName: `${testStudents[3].firstName} ${testStudents[3].lastName}`,
                    grade: testStudents[3].grade,
                    destination: dest,
                    duration: 10,
                    createdAt: time2.toISOString(),
                    status: 'returned',
                    returnedAt: new Date(time2.getTime() + 10 * 60000).toISOString(),
                    school: 'highschool',
                    isTestData: true
                });
            }
            
            // Add some random noise passes
            for (let i = 0; i < 20; i++) {
                const studentIdx = Math.floor(Math.random() * testStudents.length);
                const dest = destinations[Math.floor(Math.random() * destinations.length)];
                const daysAgo = Math.floor(Math.random() * 30);
                const date = new Date(now.getTime() - (daysAgo * 24 * 60 * 60 * 1000));
                date.setHours(Math.floor(Math.random() * 7) + 9, Math.floor(Math.random() * 60), 0, 0);
                
                hallPasses.push({
                    id: `testpass_noise_${i}`,
                    studentId: testStudents[studentIdx].id,
                    studentName: `${testStudents[studentIdx].firstName} ${testStudents[studentIdx].lastName}`,
                    grade: testStudents[studentIdx].grade,
                    destination: dest,
                    duration: 5,
                    createdAt: date.toISOString(),
                    status: 'returned',
                    returnedAt: new Date(date.getTime() + 5 * 60000).toISOString(),
                    school: 'highschool',
                    isTestData: true
                });
            }
            
            alert('✅ Test Data Generated!\n\n' +
                  '• 10 test students created\n' +
                  '• 50 test passes generated\n' +
                  '• 2-3 suspicious patterns included\n\n' +
                  'Go to Pattern Detection to analyze!');
            
            analyzeEncounterPatterns();
        }
        
        // Generate specific vaping scenario
        function generateVapingScenario() {
            const testStudents = [
                {
                    id: 'TEST2001',
                    firstName: 'VapeTest',
                    lastName: 'StudentA',
                    grade: '10',
                    pbisTickets: 0,
                    attendanceTickets: 0,
                    academicTickets: 0,
                    bigRaffleQualified: false,
                    weeksQualified: 0,
                    ticketHistory: [],
                    wildcatCashBalance: 0,
                    wildcatCashEarned: 0,
                    wildcatCashSpent: 0,
                    wildcatCashDeducted: 0,
                    wildcatCashTransactions: [],
                    wildcatCashRewardsRedeemed: [],
                    sections: [],
                    isTestData: true
                },
                {
                    id: 'TEST2002',
                    firstName: 'VapeTest',
                    lastName: 'StudentB',
                    grade: '10',
                    pbisTickets: 0,
                    attendanceTickets: 0,
                    academicTickets: 0,
                    bigRaffleQualified: false,
                    weeksQualified: 0,
                    ticketHistory: [],
                    wildcatCashBalance: 0,
                    wildcatCashEarned: 0,
                    wildcatCashSpent: 0,
                    wildcatCashDeducted: 0,
                    wildcatCashTransactions: [],
                    wildcatCashRewardsRedeemed: [],
                    sections: [],
                    isTestData: true
                }
            ];
            
            students.push(...testStudents);
            
            const now = new Date();
            
            // Create 7 highly suspicious bathroom overlaps
            for (let i = 0; i < 7; i++) {
                const date = new Date(now.getTime() - (i * 2 * 24 * 60 * 60 * 1000));
                const baseTime = new Date(date);
                baseTime.setHours(14, 15, 0, 0);
                
                hallPasses.push({
                    id: `vapetest_${i}_a`,
                    studentId: testStudents[0].id,
                    studentName: `${testStudents[0].firstName} ${testStudents[0].lastName}`,
                    grade: testStudents[0].grade,
                    destination: 'bathroom',
                    duration: 5,
                    createdAt: baseTime.toISOString(),
                    status: 'returned',
                    returnedAt: new Date(baseTime.getTime() + 5 * 60000).toISOString(),
                    school: 'highschool',
                    isTestData: true
                });
                
                const time2 = new Date(baseTime.getTime() + (1 + Math.random()) * 60000); // 1-2 min later
                hallPasses.push({
                    id: `vapetest_${i}_b`,
                    studentId: testStudents[1].id,
                    studentName: `${testStudents[1].firstName} ${testStudents[1].lastName}`,
                    grade: testStudents[1].grade,
                    destination: 'bathroom',
                    duration: 5,
                    createdAt: time2.toISOString(),
                    status: 'returned',
                    returnedAt: new Date(time2.getTime() + 5 * 60000).toISOString(),
                    school: 'highschool',
                    isTestData: true
                });
            }
            
            alert('✅ Vaping Scenario Generated!\n\n' +
                  '• 2 students created\n' +
                  '• 7 bathroom overlaps (all within 2 min)\n' +
                  '• High suspicion pattern (Score: ~28)\n\n' +
                  'This should appear as a red alert in Pattern Detection!');
            
            analyzeEncounterPatterns();
        }
        
        // Clear all test data
        function clearTestData() {
            const originalStudentCount = students.length;
            const originalPassCount = hallPasses.length;
            
            students = students.filter(s => !s.isTestData);
            hallPasses = hallPasses.filter(p => !p.isTestData);
            preventionGroups = preventionGroups.filter(g => !g.isTestData);
            
            const removedStudents = originalStudentCount - students.length;
            const removedPasses = originalPassCount - hallPasses.length;
            
            alert(`✅ Test Data Cleared!\n\n` +
                  `• ${removedStudents} test students removed\n` +
                  `• ${removedPasses} test passes removed\n` +
                  `• Test prevention groups removed`);
            
            analyzeEncounterPatterns();
            updatePreventionGroupsDisplay();
        }
        
        // Analyze encounter patterns
        async function analyzeEncounterPatterns() {
            document.getElementById('patternAnalysisStatus').textContent = '🔄 Analyzing...';
            
            const timeRange = parseInt(document.getElementById('patternTimeRange').value);
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - timeRange);
            
            // Get passes in time range
            let passesToAnalyze = hallPasses.filter(p => new Date(p.createdAt) >= cutoffDate);
            
            // Filter by test mode
            if (encounterTestMode) {
                passesToAnalyze = passesToAnalyze.filter(p => p.isTestData);
            } else {
                passesToAnalyze = passesToAnalyze.filter(p => !p.isTestData);
            }
            
            // Find overlaps
            const overlaps = [];
            for (let i = 0; i < passesToAnalyze.length; i++) {
                for (let j = i + 1; j < passesToAnalyze.length; j++) {
                    const pass1 = passesToAnalyze[i];
                    const pass2 = passesToAnalyze[j];
                    
                    if (pass1.studentId === pass2.studentId) continue;
                    if (pass1.destination !== pass2.destination) continue;
                    
                    const time1 = new Date(pass1.createdAt);
                    const time2 = new Date(pass2.createdAt);
                    const diffMinutes = Math.abs(time2 - time1) / 60000;
                    
                    if (diffMinutes <= 10) {
                        overlaps.push({
                            students: [pass1.studentId, pass2.studentId].sort(),
                            studentNames: [pass1.studentName, pass2.studentName],
                            location: pass1.destination,
                            timeDiff: diffMinutes,
                            date: pass1.createdAt
                        });
                    }
                }
            }
            
            // Group by student pairs
            const patterns = {};
            overlaps.forEach(overlap => {
                const key = overlap.students.join('_');
                if (!patterns[key]) {
                    patterns[key] = {
                        students: overlap.students,
                        studentNames: overlap.studentNames,
                        overlaps: []
                    };
                }
                patterns[key].overlaps.push(overlap);
            });
            
            // Calculate suspicion scores
            detectedPatterns = Object.values(patterns).map(pattern => {
                const score = calculateSuspicionScore(pattern);
                return { ...pattern, suspicionScore: score };
            }).sort((a, b) => b.suspicionScore - a.suspicionScore);
            
            displayPatterns();
            
            document.getElementById('patternAnalysisStatus').textContent = 
                `✅ Found ${detectedPatterns.length} pattern(s) in last ${timeRange} days`;
        }
        
        // Calculate suspicion score
        function calculateSuspicionScore(pattern) {
            const overlaps = pattern.overlaps;
            
            // Frequency (0-15 points)
            const frequency = overlaps.length;
            const frequencyScore = Math.min(frequency * 2, 15);
            
            // Consistency - same location? (0-10 points)
            const locations = overlaps.map(o => o.location);
            const uniqueLocations = [...new Set(locations)];
            const consistencyScore = uniqueLocations.length === 1 ? 10 : 5;
            
            // Location risk (0-5 points) - bathroom is highest risk
            const bathroomCount = locations.filter(l => l === 'bathroom').length;
            const locationScore = (bathroomCount / locations.length) * 5;
            
            // Timing tightness (0-5 points)
            const avgTimeDiff = overlaps.reduce((sum, o) => sum + o.timeDiff, 0) / overlaps.length;
            const timingScore = avgTimeDiff <= 3 ? 5 : (avgTimeDiff <= 5 ? 3 : 1);
            
            return Math.round(frequencyScore + consistencyScore + locationScore + timingScore);
        }
        
        // Display detected patterns
        function displayPatterns() {
            const container = document.getElementById('detectedPatternsContainer');
            
            if (detectedPatterns.length === 0) {
                container.innerHTML = `
                    <div style="background: white; padding: 40px; border-radius: 12px; text-align: center;">
                        <div style="font-size: 48px; margin-bottom: 15px;">📊</div>
                        <h3 style="color: #666; margin: 0;">No Patterns Detected</h3>
                        <p style="color: #999; margin-top: 10px;">No overlapping pass patterns found in the selected time range.</p>
                        ${encounterTestMode ? '<button class="btn" onclick="generateTestData()" style="margin-top: 20px;">🎲 Generate Test Data</button>' : ''}
                    </div>
                `;
                return;
            }
            
            const highSuspicion = detectedPatterns.filter(p => p.suspicionScore >= 25);
            const mediumSuspicion = detectedPatterns.filter(p => p.suspicionScore >= 15 && p.suspicionScore < 25);
            const lowSuspicion = detectedPatterns.filter(p => p.suspicionScore < 15);
            
            let html = '';
            
            // High suspicion patterns
            if (highSuspicion.length > 0) {
                html += '<h3 style="color: #ef4444; margin-bottom: 15px;">🔴 High Suspicion Patterns</h3>';
                highSuspicion.forEach(pattern => {
                    html += renderPatternCard(pattern, 'high');
                });
            }
            
            // Medium suspicion patterns
            if (mediumSuspicion.length > 0) {
                html += '<h3 style="color: #f59e0b; margin: 25px 0 15px 0;">🟡 Medium Suspicion Patterns</h3>';
                mediumSuspicion.forEach(pattern => {
                    html += renderPatternCard(pattern, 'medium');
                });
            }
            
            // Low suspicion patterns  
            if (lowSuspicion.length > 0) {
                html += '<h3 style="color: #10b981; margin: 25px 0 15px 0;">🟢 Low Suspicion Patterns</h3>';
                lowSuspicion.forEach(pattern => {
                    html += renderPatternCard(pattern, 'low');
                });
            }
            
            container.innerHTML = html;
        }
        
        // Render individual pattern card
        function renderPatternCard(pattern, level) {
            const borderColor = level === 'high' ? '#ef4444' : level === 'medium' ? '#f59e0b' : '#10b981';
            const bgColor = level === 'high' ? '#fee2e2' : level === 'medium' ? '#fef3c7' : '#d1fae5';
            
            const locations = pattern.overlaps.map(o => o.location);
            const uniqueLocations = [...new Set(locations)];
            const avgTime = (pattern.overlaps.reduce((sum, o) => sum + o.timeDiff, 0) / pattern.overlaps.length).toFixed(1);
            
            const locationCounts = {};
            locations.forEach(loc => {
                locationCounts[loc] = (locationCounts[loc] || 0) + 1;
            });
            
            const recommendation = level === 'high' 
                ? 'High frequency, consistent location, tight timing - likely coordinated.'
                : level === 'medium'
                ? 'Moderate frequency - may be coincidence. Monitor for 2 more weeks.'
                : 'Likely coincidence - no action needed.';
            
            let timeline = '';
            pattern.overlaps.slice(0, 7).forEach((overlap, idx) => {
                const date = new Date(overlap.date).toLocaleDateString();
                timeline += `<div style="padding: 8px; background: white; border-radius: 6px; margin-bottom: 6px;">
                    ${date} - ${overlap.location.charAt(0).toUpperCase() + overlap.location.slice(1)} (${overlap.timeDiff.toFixed(1)} min gap)
                </div>`;
            });
            
            if (pattern.overlaps.length > 7) {
                timeline += `<div style="color: #666; font-size: 13px; margin-top: 5px;">+ ${pattern.overlaps.length - 7} more occurrences</div>`;
            }
            
            return `
                <div style="background: white; padding: 25px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 20px; border-left: 4px solid ${borderColor};">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 20px;">
                        <div>
                            <h4 style="margin: 0 0 5px 0; font-size: 18px;">${pattern.studentNames[0]} & ${pattern.studentNames[1]}</h4>
                            <div style="font-size: 14px; color: #666;">Suspicion Score: ${pattern.suspicionScore} / 35</div>
                        </div>
                        <div style="background: ${bgColor}; color: ${borderColor}; padding: 8px 16px; border-radius: 20px; font-weight: 600; font-size: 14px;">
                            ${level.toUpperCase()}
                        </div>
                    </div>
                    
                    <div style="background: #f9fafb; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                        <strong>📊 Statistics:</strong>
                        <div style="margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px;">
                            <div>• ${pattern.overlaps.length} overlapping passes</div>
                            <div>• Avg gap: ${avgTime} minutes</div>
                            <div>• Locations: ${uniqueLocations.join(', ')}</div>
                        </div>
                    </div>
                    
                    <div style="margin-bottom: 15px;">
                        <strong>📅 Recent Timeline:</strong>
                        <div style="margin-top: 10px; max-height: 200px; overflow-y: auto;">
                            ${timeline}
                        </div>
                    </div>
                    
                    <div style="background: ${bgColor}; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                        <strong>💡 Recommendation:</strong>
                        <div style="margin-top: 5px;">${recommendation}</div>
                    </div>
                    
                    <div style="display: flex; gap: 10px;">
                        <button class="btn" onclick='createGroupFromPattern(${JSON.stringify(pattern.students)}, "${pattern.studentNames[0]} & ${pattern.studentNames[1]}")' style="background: #10b981;">
                            🛡️ Create Prevention Group
                        </button>
                        ${level !== 'low' ? `<button class="btn btn-secondary" onclick="dismissPattern()">❌ Dismiss</button>` : ''}
                    </div>
                </div>
            `;
        }
        
        // Create prevention group from detected pattern
        function createGroupFromPattern(studentIds, suggestedName) {
            groupStudents = studentIds.map(id => students.find(s => s.id === id));
            document.getElementById('groupName').value = suggestedName;
            openCreateGroupModal();
        }
        
        // Open create/edit group modal
        function openCreateGroupModal() {
            encounterGroupToEdit = null;
            document.getElementById('groupModalTitle').textContent = 'Create Prevention Group';
            
            // Populate student dropdown
            const select = document.getElementById('addStudentSelect');
            select.innerHTML = '<option value="">Select student to add...</option>';
            
            let studentsToShow = encounterTestMode 
                ? students.filter(s => s.isTestData)
                : students.filter(s => !s.isTestData);
            
            studentsToShow.forEach(student => {
                const option = document.createElement('option');
                option.value = student.id;
                option.textContent = `${student.firstName} ${student.lastName} (${student.id})`;
                select.appendChild(option);
            });
            
            updateGroupStudentsList();
            document.getElementById('preventionGroupModal').classList.remove('hidden');
        }
        
        // Add student to group
        function addStudentToGroup() {
            const select = document.getElementById('addStudentSelect');
            const studentId = select.value;
            
            console.log('=== ADD STUDENT TO GROUP ===');
            console.log('Selected student ID:', studentId);
            
            if (!studentId) {
                console.log('No student ID selected');
                return;
            }
            
            const student = students.find(s => s.id === studentId);
            console.log('Found student:', student);
            
            if (!student) {
                console.log('Student not found in students array');
                return;
            }
            
            if (groupStudents.find(s => s.id === studentId)) {
                alert('This student is already in the group');
                return;
            }
            
            groupStudents.push(student);
            console.log('Student added. groupStudents now:', groupStudents);
            updateGroupStudentsList();
            select.value = '';
        }
        
        // Update group students list display
        function updateGroupStudentsList() {
            const container = document.getElementById('groupStudentsList');
            
            if (groupStudents.length === 0) {
                container.innerHTML = '<p style="color: #999; margin: 0;">No students selected</p>';
                return;
            }
            
            container.innerHTML = groupStudents.map(s => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: white; border-radius: 6px; margin-bottom: 8px;">
                    <span><strong>${s.firstName} ${s.lastName}</strong> (${s.id})</span>
                    <button onclick="removeStudentFromGroup('${s.id}')" style="background: #ef4444; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">Remove</button>
                </div>
            `).join('');
        }
        
        // Remove student from group
        function removeStudentFromGroup(studentId) {
            groupStudents = groupStudents.filter(s => s.id !== studentId);
            updateGroupStudentsList();
        }
        
        // Save prevention group
        async function savePreventionGroup() {
            console.log('=== SAVE PREVENTION GROUP ===');
            console.log('groupStudents:', groupStudents);
            
            const name = document.getElementById('groupName').value.trim();
            
            if (!name) {
                alert('Please enter a group name');
                return;
            }
            
            if (groupStudents.length < 2) {
                alert('Please add at least 2 students to the group');
                console.log('Not enough students - need at least 2, have:', groupStudents.length);
                return;
            }
            
            const timeWindow = parseInt(document.getElementById('blockTimeWindow').value);
            const locations = Array.from(document.querySelectorAll('.groupLocation:checked')).map(cb => cb.value);
            const monitorOnly = document.getElementById('monitorOnlyMode').checked;
            const reason = document.getElementById('groupReason').value.trim();
            
            const group = {
                id: encounterGroupToEdit?.id || `group_${Date.now()}`,
                name: name,
                students: groupStudents.map(s => s.id),
                rules: {
                    blockIfWithinMinutes: timeWindow,
                    locations: locations,
                    allDay: true
                },
                monitorOnly: monitorOnly,
                reason: reason,
                createdAt: encounterGroupToEdit?.createdAt || new Date().toISOString(),
                createdBy: currentUser.email,
                active: true,
                blockLog: encounterGroupToEdit?.blockLog || [],
                isTestData: encounterTestMode
            };
            
            console.log('Created group object:', group);
            console.log('Group students array:', group.students);
            
            if (encounterGroupToEdit) {
                const index = preventionGroups.findIndex(g => g.id === encounterGroupToEdit.id);
                preventionGroups[index] = group;
            } else {
                preventionGroups.push(group);
            }
            
            console.log('preventionGroups after save:', preventionGroups);
            
            await saveData();
            
            closePreventionGroupModal();
            updatePreventionGroupsDisplay();
            
            alert(`✅ Prevention Group ${encounterGroupToEdit ? 'Updated' : 'Created'}!\n\n` +
                  `Group: ${name}\n` +
                  `Students: ${groupStudents.length}\n` +
                  `Mode: ${monitorOnly ? 'Monitor Only' : 'Active Blocking'}`);
        }
        
        // Close prevention group modal
        function closePreventionGroupModal() {
            document.getElementById('preventionGroupModal').classList.add('hidden');
            groupStudents = [];
            encounterGroupToEdit = null;
        }
        
        // Update prevention groups display
        function updatePreventionGroupsDisplay() {
            const container = document.getElementById('preventionGroupsContainer');
            
            let groupsToShow = encounterTestMode
                ? preventionGroups.filter(g => g.isTestData)
                : preventionGroups.filter(g => !g.isTestData);
            
            if (groupsToShow.length === 0) {
                container.innerHTML = `
                    <div style="background: white; padding: 40px; border-radius: 12px; text-align: center;">
                        <div style="font-size: 48px; margin-bottom: 15px;">🛡️</div>
                        <h3 style="color: #666; margin: 0;">No Prevention Groups</h3>
                        <p style="color: #999; margin-top: 10px;">Create a prevention group to block coordinated pass attempts.</p>
                        <button class="btn" onclick="openCreateGroupModal()" style="margin-top: 20px; background: #10b981;">➕ Create New Group</button>
                    </div>
                `;
                return;
            }
            
            container.innerHTML = groupsToShow.map(group => {
                const studentNames = group.students
                    .map(id => students.find(s => s.id === id))
                    .filter(s => s)
                    .map(s => `${s.firstName} ${s.lastName}`)
                    .join(', ');
                
                const recentBlocks = group.blockLog?.slice(-3).reverse() || [];
                
                return `
                    <div style="background: white; padding: 25px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 20px; border-left: 4px solid ${group.monitorOnly ? '#3b82f6' : '#ef4444'};">
                        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 15px;">
                            <div>
                                <h3 style="margin: 0 0 5px 0;">${group.name}</h3>
                                <div style="font-size: 14px; color: #666;">
                                    ${group.monitorOnly ? '👁️ Monitor Only' : '🔴 Active Blocking'} | Created ${new Date(group.createdAt).toLocaleDateString()}
                                </div>
                            </div>
                            <div style="display: flex; gap: 8px;">
                                <button class="btn btn-secondary" onclick='editPreventionGroup("${group.id}")' style="padding: 8px 16px;">✏️ Edit</button>
                                <button class="btn" onclick='deletePreventionGroup("${group.id}")' style="padding: 8px 16px; background: #ef4444;">🗑️</button>
                            </div>
                        </div>
                        
                        <div style="background: #f9fafb; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                            <strong>Students:</strong> ${studentNames}
                        </div>
                        
                        <div style="background: #f9fafb; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                            <strong>Rules:</strong>
                            <div style="margin-top: 8px;">
                                • Block if within ${group.rules.blockIfWithinMinutes} minutes
                                <br>• Locations: ${group.rules.locations.join(', ')}
                            </div>
                        </div>
                        
                        ${group.reason ? `
                            <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                                <strong>Reason:</strong> ${group.reason}
                            </div>
                        ` : ''}
                        
                        ${recentBlocks.length > 0 ? `
                            <div style="margin-top: 15px;">
                                <strong>${group.monitorOnly ? '👁️ Monitored Events' : '🚨 Recent Blocks'} (Last 3):</strong>
                                <div style="margin-top: 10px;">
                                    ${recentBlocks.map(block => `
                                        <div style="padding: 10px; background: #f9fafb; border-radius: 6px; margin-bottom: 8px; font-size: 14px;">
                                            ${new Date(block.timestamp).toLocaleString()} - ${block.blockedStudent} ${group.monitorOnly ? 'would have been blocked' : 'blocked'} (${block.activeStudent} had active ${block.location} pass)
                                        </div>
                                    `).join('')}
                                </div>
                            </div>
                        ` : ''}
                    </div>
                `;
            }).join('');
        }
        
        // Edit prevention group
        function editPreventionGroup(groupId) {
            const group = preventionGroups.find(g => g.id === groupId);
            if (!group) return;
            
            encounterGroupToEdit = group;
            groupStudents = group.students
                .map(id => students.find(s => s.id === id))
                .filter(s => s);
            
            document.getElementById('groupModalTitle').textContent = 'Edit Prevention Group';
            document.getElementById('groupName').value = group.name;
            document.getElementById('blockTimeWindow').value = group.rules.blockIfWithinMinutes;
            document.getElementById('monitorOnlyMode').checked = group.monitorOnly;
            document.getElementById('groupReason').value = group.reason || '';
            
            // Set location checkboxes
            document.querySelectorAll('.groupLocation').forEach(cb => {
                cb.checked = group.rules.locations.includes(cb.value);
            });
            
            updateGroupStudentsList();
            
            // Populate student dropdown
            const select = document.getElementById('addStudentSelect');
            select.innerHTML = '<option value="">Select student to add...</option>';
            
            let studentsToShow = encounterTestMode 
                ? students.filter(s => s.isTestData)
                : students.filter(s => !s.isTestData);
            
            studentsToShow.forEach(student => {
                const option = document.createElement('option');
                option.value = student.id;
                option.textContent = `${student.firstName} ${student.lastName} (${student.id})`;
                select.appendChild(option);
            });
            
            document.getElementById('preventionGroupModal').classList.remove('hidden');
        }
        
        // Delete prevention group
        async function deletePreventionGroup(groupId) {
            const group = preventionGroups.find(g => g.id === groupId);
            if (!group) return;
            
            if (!confirm(`Delete prevention group "${group.name}"?\n\nThis cannot be undone.`)) {
                return;
            }
            
            preventionGroups = preventionGroups.filter(g => g.id !== groupId);
            await saveData();
            
            updatePreventionGroupsDisplay();
            alert(`✅ Prevention group "${group.name}" deleted.`);
        }
        
        // Check if pass should be blocked by prevention groups
        function checkEncounterPrevention(studentId, destination) {
            console.log('>>> checkEncounterPrevention called');
            console.log('>>> studentId:', studentId);
            console.log('>>> destination:', destination);
            
            const now = new Date();
            
            // Check if this student is test data
            const student = students.find(s => s.id === studentId);
            console.log('>>> Found student:', student);
            
            if (!student) {
                console.log('>>> Student not found - returning null');
                return null;
            }
            
            const isTestStudent = student.isTestData === true;
            console.log('>>> Is test student:', isTestStudent);
            console.log('>>> encounterTestMode:', encounterTestMode);
            
            // Test Mode: Only check test students (ignore real students)
            // Live Mode: Only check real students (ignore test students)
            if (encounterTestMode && !isTestStudent) {
                console.log('>>> Test mode but not a test student - returning null');
                return null;
            }
            if (!encounterTestMode && isTestStudent) {
                console.log('>>> Live mode but is a test student - returning null');
                return null;
            }
            
            console.log('>>> Checking prevention groups...');
            console.log('>>> Total prevention groups:', preventionGroups.length);
            
            // Find all groups this student is in (matching test/live mode)
            const studentGroups = preventionGroups.filter(g => {
                console.log('>>> Checking group:', g.name);
                console.log('>>>   - active:', g.active);
                console.log('>>>   - includes student:', g.students.includes(studentId));
                console.log('>>>   - isTestData:', g.isTestData);
                
                if (!g.active) return false;
                if (!g.students.includes(studentId)) return false;
                // In test mode, only use test groups; in live mode, only use live groups
                if (encounterTestMode && !g.isTestData) return false;
                if (!encounterTestMode && g.isTestData) return false;
                return true;
            });
            
            console.log('>>> Student groups found:', studentGroups.length);
            
            for (const group of studentGroups) {
                console.log('>>> Processing group:', group.name);
                console.log('>>>   - locations:', group.rules.locations);
                console.log('>>>   - destination match:', group.rules.locations.includes(destination));
                
                // Check if destination applies
                if (!group.rules.locations.includes(destination)) continue;
                
                console.log('>>> Checking other students in group...');
                // Check for other students in group with recent/active passes
                for (const otherStudentId of group.students) {
                    if (otherStudentId === studentId) continue;
                    
                    console.log('>>>   - Checking student:', otherStudentId);
                    
                    // Find recent passes from other student
                    const otherPasses = hallPasses.filter(p => 
                        p.studentId === otherStudentId &&
                        (p.status === 'active' || p.status === 'expiring') &&
                        p.destination === destination
                    );
                    
                    console.log('>>>   - Other student passes:', otherPasses);
                    
                    if (otherPasses.length > 0) {
                        console.log('>>> 🚨 CONFLICT FOUND! Blocking...');
                        const otherStudent = students.find(s => s.id === otherStudentId);
                        
                        // Log the block
                        if (!group.blockLog) group.blockLog = [];
                        group.blockLog.push({
                            timestamp: now.toISOString(),
                            blockedStudent: students.find(s => s.id === studentId)?.firstName + ' ' + students.find(s => s.id === studentId)?.lastName,
                            activeStudent: otherStudent?.firstName + ' ' + otherStudent?.lastName,
                            location: destination,
                            groupId: group.id
                        });
                        
                        saveData();
                        
                        return {
                            blocked: !group.monitorOnly,
                            group: group,
                            conflictingStudent: otherStudent,
                            monitorOnly: group.monitorOnly
                        };
                    }
                }
            }
            
            console.log('>>> No conflicts found - returning null');
            return null;
        }
        
        // Dismiss pattern (placeholder)
        function dismissPattern() {
            alert('Pattern dismissed (feature placeholder)');
        }

        // ============================================
        // END CLAW PASS FUNCTIONS
        // ============================================

        function resetTeacherPassword(teacherId) {
            if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
                alert('Only admins can reset passwords');
                return;
            }

            const teacher = teachers.find(t => t.id === teacherId);
            if (!teacher) {
                alert('Teacher not found');
                return;
            }

            const newPassword = prompt(`Reset password for ${teacher.name}\n\nEnter new password:`);
            
            if (!newPassword) {
                return; // User cancelled
            }

            if (newPassword.length < 4) {
                alert('Password must be at least 4 characters');
                return;
            }

            const confirmPassword = prompt('Confirm new password:');
            
            if (newPassword !== confirmPassword) {
                alert('Passwords do not match. Please try again.');
                return;
            }

            // Update password
            teacher.password = newPassword;
            saveData();
            
            alert(`✅ Password reset successfully for ${teacher.name}\n\nNew password: ${newPassword}\n\nMake sure to share this with the teacher securely!`);
        }

        function updateTeachersTable() {
            const tbody = document.getElementById('teachersTable');
            if (!tbody) {
                console.error('Teachers table body not found');
                return;
            }
            
            try {
                tbody.innerHTML = teachers.map(t => {
                    let roleDisplay = t.role;
                    let roleColor = '#6c757d';
                    
                    if (t.role === 'superadmin') {
                        roleDisplay = '👑 Super Admin';
                        roleColor = '#dc3545';
                    } else if (t.role === 'admin') {
                        roleDisplay = '⭐ Admin';
                        roleColor = '#667eea';
                    } else if (t.role === 'campusaide') {
                        roleDisplay = '👁️ Campus Aide';
                        roleColor = '#10b981';
                    } else {
                        roleDisplay = '👤 Teacher';
                        roleColor = '#28a745';
                    }
                    
                    return `
                    <tr>
                        <td>${t.name || 'Unknown'}</td>
                        <td>${t.username || 'N/A'}</td>
                        <td>${t.email || '<span style="color: #dc3545;">No email</span>'}</td>
                        <td><span class="teacher-badge" style="background: ${roleColor};">${roleDisplay}</span></td>
                        <td>${t.ticketsAwarded || 0}</td>
                        <td>
                            <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 14px; margin-right: 5px;" onclick="editTeacher('${t.id}')">✏️ Edit</button>
                            ${t.id !== currentUser.id ? `
                                <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 14px; margin-right: 5px;" onclick="resetTeacherPassword('${t.id}')">Reset Password</button>
                                <button class="btn btn-danger" style="padding: 6px 12px; font-size: 14px;" onclick="deleteTeacher('${t.id}')">Delete</button>
                            ` : '<span style="color: #999; display: block; margin-top: 5px;">Current User</span>'}
                        </td>
                    </tr>
                `}).join('');
            } catch (error) {
                console.error('Error updating teachers table:', error);
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: #dc3545;">Error loading teachers. Please refresh the page.</td></tr>';
            }
        }

        function uploadFile() {
            const fileInput = document.getElementById('fileInput');
            const file = fileInput.files[0];
            
            if (!file) {
                alert('Please select a file first!');
                return;
            }

            const reader = new FileReader();
            reader.onload = function(e) {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, {type: 'array'});
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                
                // First, try reading as array (no headers)
                const arrayData = XLSX.utils.sheet_to_json(firstSheet, {header: 1});
                
                console.log('First 3 rows as arrays:', arrayData.slice(0, 3));
                
                // Check format type
                // New format: Has header row with "Student Number", "First Name", etc.
                const hasHeaders = arrayData[0] && 
                                  (arrayData[0].includes('Student Number') || 
                                   arrayData[0].includes('First Name'));
                
                if (hasHeaders) {
                    console.log('Detected: New PowerSchool format with headers');
                    importPowerSchoolWithHeaders(arrayData);
                } else {
                    // Old format: 6 columns, row 1 has student ID in column 1
                    const isPowerSchoolOld = arrayData.length >= 2 && 
                                             arrayData[1] && 
                                             arrayData[1].length === 6 &&
                                             /^\d+$/.test(String(arrayData[1][1] || '').trim());
                    
                    console.log('Detected as PowerSchool old format:', isPowerSchoolOld);
                    
                    if (isPowerSchoolOld) {
                        importPowerSchoolSchedule(arrayData);
                    } else {
                        // Try traditional student list import
                        importTraditionalCSV(workbook);
                    }
                }
            };
            reader.readAsArrayBuffer(file);
        }
        
        function importPowerSchoolWithHeaders(data) {
            // New PowerSchool format: [Student Number, First Name, Last Name, Grade, Course, Period, Teacher]
            const studentMap = new Map();
            const teacherSectionMap = new Map();
            
            console.log('Importing new PowerSchool format with headers');
            
            // Start with existing students to preserve their data
            students.forEach(student => {
                studentMap.set(student.id, {
                    ...student,  // Preserve all existing data (tickets, cash, history)
                    sections: [] // Reset sections - will be rebuilt from CSV
                });
            });
            
            // Skip header row (row 0)
            for (let i = 1; i < data.length; i++) {
                const row = data[i];
                if (!row || row.length < 7) continue;
                
                // Extract fields directly (already in correct format!)
                const studentId = String(row[0] || '').trim();
                const firstName = String(row[1] || '').trim();
                const lastName = String(row[2] || '').trim();
                const grade = String(row[3] || '').trim();
                const courseName = String(row[4] || '').trim();
                const periodRaw = String(row[5] || '').trim();
                const teacherName = String(row[6] || '').trim();
                
                // Debug first row
                if (i === 1) {
                    console.log('First student data:');
                    console.log('  Student ID:', studentId);
                    console.log('  First Name:', firstName);
                    console.log('  Last Name:', lastName);
                    console.log('  Grade:', grade);
                    console.log('  Course:', courseName);
                    console.log('  Period:', periodRaw);
                    console.log('  Teacher:', teacherName);
                }
                
                // Skip if missing critical data
                if (!studentId || !firstName || !lastName) continue;
                
                // Extract period from format like "P1(M-Fri)"
                const periodMatch = periodRaw.match(/([A-Z]+\d+)/);
                const period = periodMatch ? periodMatch[1] : periodRaw;
                
                // Parse teacher name (format: "Last, First")
                const teacherParts = teacherName.split(',').map(s => s.trim());
                const teacherLastName = teacherParts[0] || '';
                const teacherFirstName = teacherParts[1] || '';
                const teacherFullName = `${teacherFirstName} ${teacherLastName}`.trim();
                
                // Add student to map if new (preserve existing students)
                if (!studentMap.has(studentId)) {
                    const studentObj = {
                        id: studentId,
                        firstName: firstName,
                        lastName: lastName,
                        grade: grade,
                        pbisTickets: 0,
                        attendanceTickets: 0,
                        academicTickets: 0,
                        bigRaffleQualified: false,
                        weeksQualified: 0,
                        ticketHistory: [],
                        sections: []  // Initialize sections array for student schedules
                    };
                    
                    if (i === 1) {
                        console.log('First student object:', studentObj);
                    }
                    
                    studentMap.set(studentId, studentObj);
                } else {
                    // Update name and grade for existing students (in case they changed)
                    const existingStudent = studentMap.get(studentId);
                    existingStudent.firstName = firstName;
                    existingStudent.lastName = lastName;
                    existingStudent.grade = grade;
                }
                
                // Add this class to the student's sections array
                const student = studentMap.get(studentId);
                if (period && courseName) {
                    if (!student.sections) {
                        console.error('❌ Student has no sections array!', studentId, student);
                        student.sections = [];
                    }
                    student.sections.push({
                        period: period,
                        courseName: courseName,
                        teacherName: teacherFullName || teacherName,
                        teacherId: null  // Will be populated if we match to a teacher account
                    });
                    
                    // Debug first few sections
                    if (i <= 5) {
                        console.log(`Row ${i}: Added ${period} ${courseName} to student ${studentId}`);
                        console.log(`  Student now has ${student.sections.length} sections`);
                    }
                }
                
                // Build teacher section mappings
                if (teacherFullName && courseName && period) {
                    const sectionKey = `${teacherFullName}|${period}|${courseName}`;
                    if (!teacherSectionMap.has(teacherFullName)) {
                        teacherSectionMap.set(teacherFullName, new Map());
                    }
                    
                    const teacherSections = teacherSectionMap.get(teacherFullName);
                    if (!teacherSections.has(sectionKey)) {
                        teacherSections.set(sectionKey, {
                            sectionId: `${period}-${courseName.replace(/\s+/g, '')}`,
                            period: period,
                            courseName: courseName,
                            students: []
                        });
                    }
                    
                    const section = teacherSections.get(sectionKey);
                    if (!section.students.includes(studentId)) {
                        section.students.push(studentId);
                    }
                }
            }
            
            // Convert maps to arrays
            students = Array.from(studentMap.values());
            
            console.log('Total unique students:', students.length);
            console.log('Sample students with sections:', students.slice(0, 3));
            
            // Check how many students have sections
            const studentsWithSections = students.filter(s => s.sections && s.sections.length > 0);
            console.log(`✅ ${studentsWithSections.length} students have schedule data`);
            console.log(`❌ ${students.length - studentsWithSections.length} students have NO schedule data`);
            
            // Show a sample student's full data
            if (students.length > 0) {
                console.log('=== SAMPLE STUDENT ===');
                console.log(students[0]);
                if (students[0].sections) {
                    console.log(`  Has ${students[0].sections.length} classes:`, students[0].sections);
                }
            }
            
            // Save teacher section map globally
            csvScheduleData = teacherSectionMap;
            console.log('Saved CSV schedule data for', csvScheduleData.size, 'teachers');
            
            // Update existing teacher section assignments
            teachers.forEach(teacher => {
                matchTeacherToSections(teacher);
            });
            
            saveData();
            updateAllDisplays();
            updateCSVScheduleStatus();
            
            const teachersWithSections = teachers.filter(t => t.sections && t.sections.length > 0).length;
            alert(`✅ Successfully imported PowerSchool schedule!\n\n` +
                  `📚 ${students.length} students\n` +
                  `👥 ${teachersWithSections} teachers matched with class rosters\n\n` +
                  `✅ All existing ticket balances and cash preserved!\n` +
                  `Students now have their class schedules loaded for period detection!`);
        }
        
        function importPowerSchoolSchedule(data) {
            // PowerSchool format: [Student Name, Student ID, Course, Period, Teacher, Term]
            const studentMap = new Map();
            const teacherSectionMap = new Map();
            
            // Debug: Log first row
            console.log('First row of data:', data[0]);
            console.log('Second row of data:', data[1]);
            console.log('Total rows:', data.length);
            
            // Start with existing students to preserve their data
            students.forEach(student => {
                studentMap.set(student.id, {
                    ...student,  // Preserve all existing data (tickets, cash, history)
                    sections: [] // Reset sections - will be rebuilt from CSV
                });
            });
            
            // Skip first row if it's empty or header
            const startRow = (data[0] && data[0].every(cell => !cell || cell === '')) ? 1 : 0;
            console.log('Starting at row:', startRow);
            
            for (let i = startRow; i < data.length; i++) {
                const row = data[i];
                if (!row || row.length < 6) continue;
                
                // Extract and clean each field
                const fullName = String(row[0] || '').trim();
                const studentId = String(row[1] || '').trim();
                const courseName = String(row[2] || '').trim();
                const periodRaw = String(row[3] || '').trim();
                const teacherName = String(row[4] || '').trim();
                const term = String(row[5] || '').trim();
                
                // Debug: Log first student processing
                if (i === startRow) {
                    console.log('First student data:');
                    console.log('  Full Name:', fullName);
                    console.log('  Student ID:', studentId);
                    console.log('  Course:', courseName);
                    console.log('  Period:', periodRaw);
                    console.log('  Teacher:', teacherName);
                }
                
                // Skip if missing critical data
                if (!studentId || !fullName || studentId === '' || fullName === '') continue;
                
                // Parse student name (format: "Last, First Middle")
                const nameParts = fullName.split(',').map(s => s.trim());
                const lastName = nameParts[0] || '';
                const firstMiddle = nameParts[1] || '';
                const firstName = firstMiddle.split(' ')[0] || '';
                
                // Extract period from format like "P1(M-Fri)" or "A1(M-Fri)"
                const periodMatch = periodRaw.match(/([A-Z]+\d+)/);
                const period = periodMatch ? periodMatch[1] : periodRaw;
                
                // Parse teacher name (format: "Last, First")
                const teacherParts = teacherName.split(',').map(s => s.trim());
                const teacherLastName = teacherParts[0] || '';
                const teacherFirstName = teacherParts[1] || '';
                const teacherFullName = `${teacherFirstName} ${teacherLastName}`.trim();
                
                // Add student to map if new (preserve existing students)
                if (!studentMap.has(studentId)) {
                    // Infer grade from course name (look for numbers like "7B", "10B", "12")
                    let grade = '';
                    const gradeMatch = courseName.match(/\b(\d{1,2})[AB]?\b/);
                    if (gradeMatch) {
                        grade = gradeMatch[1];
                    }
                    
                    const studentObj = {
                        id: studentId,
                        firstName: firstName,
                        lastName: lastName,
                        grade: grade,
                        pbisTickets: 0,
                        attendanceTickets: 0,
                        academicTickets: 0,
                        bigRaffleQualified: false,
                        weeksQualified: 0,
                        ticketHistory: [],
                        sections: []  // Initialize sections array for student schedules
                    };
                    
                    // Debug: Log first student object
                    if (i === startRow) {
                        console.log('First student object created:', studentObj);
                    }
                    
                    studentMap.set(studentId, studentObj);
                } else {
                    // Update name and grade for existing students (in case they changed)
                    const existingStudent = studentMap.get(studentId);
                    existingStudent.firstName = firstName;
                    existingStudent.lastName = lastName;
                    // Update grade if we inferred one
                    const gradeMatch = courseName.match(/\b(\d{1,2})[AB]?\b/);
                    if (gradeMatch) {
                        existingStudent.grade = gradeMatch[1];
                    }
                }
                
                // Add this class to the student's sections array
                const student = studentMap.get(studentId);
                if (period && courseName) {
                    student.sections.push({
                        period: period,
                        courseName: courseName,
                        teacherName: teacherFullName || teacherName,
                        teacherId: null  // Will be populated if we match to a teacher account
                    });
                }
                
                // Build teacher section mappings (only if we have teacher and course info)
                if (teacherFullName && courseName && period) {
                    const sectionKey = `${teacherFullName}|${period}|${courseName}`;
                    if (!teacherSectionMap.has(teacherFullName)) {
                        teacherSectionMap.set(teacherFullName, new Map());
                    }
                    
                    const teacherSections = teacherSectionMap.get(teacherFullName);
                    if (!teacherSections.has(sectionKey)) {
                        teacherSections.set(sectionKey, {
                            sectionId: `${period}-${courseName.replace(/\s+/g, '')}`,
                            period: period,
                            courseName: courseName,
                            students: []
                        });
                    }
                    
                    const section = teacherSections.get(sectionKey);
                    if (!section.students.includes(studentId)) {
                        section.students.push(studentId);
                    }
                }
            }
            
            // Convert maps to arrays
            students = Array.from(studentMap.values());
            
            console.log('Total unique students:', students.length);
            console.log('Sample students:', students.slice(0, 3));
            
            // Save teacher section map globally for future use
            csvScheduleData = teacherSectionMap;
            console.log('Saved CSV schedule data for', csvScheduleData.size, 'teachers');
            
            // Update existing teacher section assignments
            teachers.forEach(teacher => {
                matchTeacherToSections(teacher);
            });
            
            saveData();
            updateAllDisplays();
            updateCSVScheduleStatus();
            
            const teachersWithSections = teachers.filter(t => t.sections && t.sections.length > 0).length;
            alert(`✅ Successfully imported PowerSchool schedule!\n\n` +
                  `📚 ${students.length} students\n` +
                  `👥 ${teachersWithSections} teachers matched with class rosters\n\n` +
                  `Teachers can now use period filtering!`);
        }
        
        // Function to match a teacher to their sections from CSV data
        function matchTeacherToSections(teacher) {
            console.log(`Attempting to match teacher: "${teacher.name}"`);
            
            // Try exact match first
            if (csvScheduleData.has(teacher.name)) {
                const sections = Array.from(csvScheduleData.get(teacher.name).values());
                teacher.sections = sections;
                console.log(`✅ Exact match: ${teacher.name} → ${sections.length} sections`);
                return true;
            }
            
            // Try case-insensitive match
            for (const [csvTeacherName, sectionMap] of csvScheduleData.entries()) {
                if (csvTeacherName.toLowerCase() === teacher.name.toLowerCase()) {
                    const sections = Array.from(sectionMap.values());
                    teacher.sections = sections;
                    console.log(`✅ Case-insensitive match: "${teacher.name}" matched to "${csvTeacherName}" → ${sections.length} sections`);
                    return true;
                }
            }
            
            // Try fuzzy match (handle slight variations)
            const normalizedTeacherName = teacher.name.toLowerCase().replace(/[^a-z]/g, '');
            for (const [csvTeacherName, sectionMap] of csvScheduleData.entries()) {
                const normalizedCSVName = csvTeacherName.toLowerCase().replace(/[^a-z]/g, '');
                if (normalizedCSVName === normalizedTeacherName) {
                    const sections = Array.from(sectionMap.values());
                    teacher.sections = sections;
                    console.log(`✅ Fuzzy match: "${teacher.name}" matched to "${csvTeacherName}" → ${sections.length} sections`);
                    return true;
                }
            }
            
            // No match found
            teacher.sections = [];
            console.log(`❌ No match found for "${teacher.name}"`);
            console.log('Available CSV teachers:', Array.from(csvScheduleData.keys()).slice(0, 5), '...');
            return false;
        }
        
        // Rematch all existing teachers to CSV data
        function rematchAllTeachers() {
            if (csvScheduleData.size === 0) {
                alert('No CSV schedule data loaded!\n\nPlease upload a PowerSchool schedule CSV first.');
                return;
            }
            
            let matched = 0;
            let unmatched = 0;
            
            teachers.forEach(teacher => {
                if (matchTeacherToSections(teacher)) {
                    matched++;
                } else {
                    unmatched++;
                }
            });
            
            saveData();
            updateAllDisplays();
            
            alert(`✅ Re-matching complete!\n\n` +
                  `Matched: ${matched} teachers\n` +
                  `No match: ${unmatched} teachers\n\n` +
                  `Unmatched teachers may have name mismatches with CSV.`);
        }
        
        // Update CSV schedule status display
        function updateCSVScheduleStatus() {
            const statusElement = document.getElementById('csvScheduleStatus');
            if (statusElement) {
                if (csvScheduleData.size > 0) {
                    statusElement.textContent = `Yes (${csvScheduleData.size} teachers in CSV)`;
                    statusElement.style.color = '#4CAF50';
                    statusElement.style.fontWeight = 'bold';
                } else {
                    statusElement.textContent = 'No';
                    statusElement.style.color = '#999';
                }
            }
        }
        
        function importTraditionalCSV(workbook) {
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(firstSheet);
            
            // Try to detect column names (case-insensitive)
            const firstRow = jsonData[0];
            const keys = Object.keys(firstRow);
            
            // Find ID column
            const idCol = keys.find(k => 
                k.toLowerCase().includes('student') && k.toLowerCase().includes('id') ||
                k.toLowerCase() === 'id' ||
                k.toLowerCase() === 'studentid' ||
                k.toLowerCase() === 'student_id'
            ) || keys[0];
            
            // Find first name column
            const firstNameCol = keys.find(k => 
                k.toLowerCase().includes('first') && k.toLowerCase().includes('name') ||
                k.toLowerCase() === 'firstname' ||
                k.toLowerCase() === 'first_name' ||
                k.toLowerCase() === 'fname'
            );
            
            // Find last name column
            const lastNameCol = keys.find(k => 
                k.toLowerCase().includes('last') && k.toLowerCase().includes('name') ||
                k.toLowerCase() === 'lastname' ||
                k.toLowerCase() === 'last_name' ||
                k.toLowerCase() === 'lname'
            );
            
            // Find full name column if first/last not found
            const fullNameCol = keys.find(k => 
                k.toLowerCase() === 'name' ||
                k.toLowerCase() === 'student name' ||
                k.toLowerCase() === 'studentname' ||
                k.toLowerCase() === 'full name' ||
                k.toLowerCase() === 'fullname'
            );
            
            // Find grade column
            const gradeCol = keys.find(k => 
                k.toLowerCase() === 'grade' ||
                k.toLowerCase().includes('grade')
            );
            
            students = jsonData.map((row, index) => {
                let firstName = '';
                let lastName = '';
                
                // Try to get first and last name
                if (firstNameCol && lastNameCol) {
                    firstName = row[firstNameCol] || '';
                    lastName = row[lastNameCol] || '';
                } else if (fullNameCol) {
                    // Split full name
                    const fullName = (row[fullNameCol] || '').trim().split(/\s+/);
                    firstName = fullName[0] || '';
                    lastName = fullName.slice(1).join(' ') || '';
                }
                
                return {
                    id: row[idCol] || `STU${String(index + 1).padStart(3, '0')}`,
                    firstName: firstName,
                    lastName: lastName,
                    grade: gradeCol ? row[gradeCol] : '',
                    homeroom: row['Homeroom'] || row['homeroom'] || '',
                    pbisTickets: 0,
                    attendanceTickets: 0,
                    academicTickets: 0,
                    bigRaffleQualified: false,
                    weeksQualified: 0,
                    ticketHistory: []
                };
            });

            saveData();
            updateAllDisplays();
            alert(`Successfully imported ${students.length} students!`);
        }

        function updateAllDisplays() {
            // Show mode toggle for superadmin
            if (currentUser && currentUser.role === 'superadmin') {
                const modeToggle = document.getElementById('modeToggleContainer');
                if (modeToggle) {
                    modeToggle.style.display = 'block';
                    updateModeToggleUI();
                }
            }
            
            // Initialize student cash accounts if in cash mode or if superadmin
            if (currentUser && currentUser.role === 'superadmin') {
                initializeStudentCashAccounts();
            }
            
            // Always use table view
            updateStudentsTable();
            
            updateTicketsTable();
            updateStats();
            updateDashboardStats(); // Update animated dashboard
            updateBigRaffleTable();
            updateAuditLogTable();
            updateDateDisplays();
            updateMyActivity();
            updateLeaderboard();
            updateCategoryDropdown(); // Update category dropdown based on role
            updateSubcategoryDropdown();
            updateSubcategoryLists();
            updatePeriodFilter();
            updateCSVScheduleStatus();
            if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'superadmin')) {
                updateTeachersTable();
            }
            if (currentUser && currentUser.role === 'superadmin') {
                updateLastSyncTime();
            }
            document.getElementById('currentWeek').textContent = currentWeek;
            document.getElementById('bigRaffleWeek').textContent = `Week ${currentWeek}`;
            
            // If in cash mode, update cash displays
            if (wildcatCashEnabled && currentUser && currentUser.role === 'superadmin') {
                updateCashPeriodFilter();
                updateCashTable();
                updateBehaviorsList();
            }
            
            // Update cycle duration displays across all tabs
            const cycleDurationInput = document.getElementById('cycleDurationInput');
            const currentWeekDisplay = document.getElementById('currentWeekDisplay');
            const cycleDurationDisplay = document.getElementById('cycleDurationDisplay');
            const cycleDurationTickets = document.getElementById('cycleDurationTickets');
            const cycleDurationLeaderboard = document.getElementById('cycleDurationLeaderboard');
            const cycleDurationBigRaffle = document.getElementById('cycleDurationBigRaffle');
            const cycleDurationReset = document.getElementById('cycleDurationReset');
            
            if (cycleDurationInput) cycleDurationInput.value = cycleDuration;
            if (currentWeekDisplay) currentWeekDisplay.textContent = currentWeek;
            if (cycleDurationDisplay) cycleDurationDisplay.textContent = cycleDuration;
            if (cycleDurationTickets) cycleDurationTickets.textContent = cycleDuration;
            if (cycleDurationLeaderboard) cycleDurationLeaderboard.textContent = cycleDuration;
            if (cycleDurationBigRaffle) cycleDurationBigRaffle.textContent = cycleDuration;
            if (cycleDurationReset) cycleDurationReset.textContent = cycleDuration;
            
            // Update leaderboard week display
            const leaderboardWeekElement = document.getElementById('leaderboardWeek');
            if (leaderboardWeekElement) leaderboardWeekElement.textContent = currentWeek;
            
            // Show mobile hint on small screens
            const mobileHint = document.querySelector('.mobile-hint');
            if (mobileHint && window.innerWidth <= 768) {
                mobileHint.style.display = 'block';
            }
        }
        
        function updateLastSyncTime() {
            const syncTimeElement = document.getElementById('lastSyncTime');
            if (syncTimeElement) {
                if (lastPowerSchoolSync) {
                    const syncDate = new Date(lastPowerSchoolSync);
                    syncTimeElement.textContent = syncDate.toLocaleString();
                } else {
                    syncTimeElement.textContent = 'Never';
                }
            }
        }

        function updateDateDisplays() {
            const today = new Date();
            const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
            const formattedDate = today.toLocaleDateString('en-US', options);
            
            // Update all date displays
            const dateElements = [
                'currentDate',
                'currentDateRaffle', 
                'currentDateBigRaffle'
            ];
            
            dateElements.forEach(id => {
                const element = document.getElementById(id);
                if (element) {
                    element.textContent = formattedDate;
                }
            });
        }

        function updateStudentsTable() {
            // Reset search box and cache
            const searchBox = document.getElementById('studentSearchBox');
            if (searchBox) searchBox.value = '';
            filteredStudentsCache = [];
            currentSort = { column: null, direction: 'asc' };
            
            // Reset sort arrows
            document.querySelectorAll('.sort-arrow').forEach(arrow => {
                arrow.textContent = '↕️';
                arrow.style.opacity = '0.3';
            });
            
            const tbody = document.getElementById('studentsTableBody');
            if (students.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: #999;">No students loaded. Upload a file to get started!</td></tr>';
                return;
            }

            // Filter students by selected grade
            let filteredStudents = students;
            if (currentGradeFilter !== 'all') {
                filteredStudents = students.filter(s => {
                    const grade = parseInt(s.grade) || 'Unknown';
                    return grade.toString() === currentGradeFilter;
                });
            }

            if (filteredStudents.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: #999;">No students found for the selected grade level.</td></tr>';
                return;
            }

            renderStudentTable(filteredStudents);
        }
        
        let currentStudentView = 'grade'; // 'grade' or 'all'
        let currentGradeFilter = 'all'; // Track which grade is selected
        
        function filterByGrade() {
            const dropdown = document.getElementById('gradeFilterDropdown');
            currentGradeFilter = dropdown.value;
            
            // Always use table view
            updateStudentsTable();
        }
        
        // ============================================
        // ENHANCED TABLE FEATURES
        // ============================================
        
        let currentSort = { column: null, direction: 'asc' };
        let filteredStudentsCache = [];
        
        // Search students by name or ID
        function searchStudents() {
            console.log('=== SEARCH FUNCTION CALLED ===');
            
            const searchBox = document.getElementById('studentSearchBox');
            console.log('Search box element:', searchBox);
            
            const searchTerm = searchBox ? searchBox.value.toLowerCase().trim() : '';
            console.log('Search term:', searchTerm);
            console.log('Total students:', students.length);
            console.log('Current grade filter:', currentGradeFilter);
            
            // Start with all students
            let filteredStudents = [...students];
            console.log('Starting with students:', filteredStudents.length);
            
            // Apply grade filter first
            if (currentGradeFilter !== 'all') {
                filteredStudents = filteredStudents.filter(s => {
                    const grade = parseInt(s.grade) || 'Unknown';
                    return grade.toString() === currentGradeFilter;
                });
                console.log('After grade filter:', filteredStudents.length);
            }
            
            // Apply search filter
            if (searchTerm) {
                console.log('Applying search filter for:', searchTerm);
                filteredStudents = filteredStudents.filter(s => {
                    const fullName = `${s.firstName} ${s.lastName}`.toLowerCase();
                    const id = (s.id || '').toString().toLowerCase();
                    const matches = fullName.includes(searchTerm) || id.includes(searchTerm);
                    if (matches) {
                        console.log('Match found:', fullName, id);
                    }
                    return matches;
                });
                console.log('After search filter:', filteredStudents.length);
            }
            
            // Cache and render
            filteredStudentsCache = filteredStudents;
            console.log('Calling renderStudentTable with', filteredStudents.length, 'students');
            renderStudentTable(filteredStudents);
            
            console.log(`✅ Search complete: "${searchTerm}" | Grade: ${currentGradeFilter} | Found: ${filteredStudents.length} students`);
        }
        
        // Sort table by column
        function sortTable(column) {
            // Toggle direction if same column, otherwise default to ascending
            if (currentSort.column === column) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.column = column;
                currentSort.direction = 'asc';
            }
            
            // Update sort arrows
            document.querySelectorAll('.sort-arrow').forEach(arrow => {
                arrow.textContent = '↕️';
                arrow.style.opacity = '0.3';
            });
            const arrow = document.getElementById(`sort-${column}`);
            if (arrow) {
                arrow.textContent = currentSort.direction === 'asc' ? '↑' : '↓';
                arrow.style.opacity = '1';
            }
            
            // Get current filtered students (from search/grade filter)
            let studentsToSort = filteredStudentsCache.length > 0 ? [...filteredStudentsCache] : [...students];
            if (currentGradeFilter !== 'all' && filteredStudentsCache.length === 0) {
                studentsToSort = students.filter(s => {
                    const grade = parseInt(s.grade) || 'Unknown';
                    return grade.toString() === currentGradeFilter;
                });
            }
            
            // Sort
            studentsToSort.sort((a, b) => {
                let aVal, bVal;
                
                switch(column) {
                    case 'id':
                        aVal = a.id;
                        bVal = b.id;
                        break;
                    case 'name':
                        aVal = `${a.firstName} ${a.lastName}`;
                        bVal = `${b.firstName} ${b.lastName}`;
                        break;
                    case 'grade':
                        aVal = parseInt(a.grade) || 0;
                        bVal = parseInt(b.grade) || 0;
                        break;
                    case 'pbis':
                        aVal = a.pbisTickets || 0;
                        bVal = b.pbisTickets || 0;
                        break;
                    case 'attendance':
                        aVal = a.attendanceTickets || 0;
                        bVal = b.attendanceTickets || 0;
                        break;
                    case 'academic':
                        aVal = a.academicTickets || 0;
                        bVal = b.academicTickets || 0;
                        break;
                    case 'total':
                        aVal = (a.pbisTickets || 0) + (a.attendanceTickets || 0) + (a.academicTickets || 0);
                        bVal = (b.pbisTickets || 0) + (b.attendanceTickets || 0) + (b.academicTickets || 0);
                        break;
                    default:
                        return 0;
                }
                
                if (typeof aVal === 'string') {
                    return currentSort.direction === 'asc' 
                        ? aVal.localeCompare(bVal)
                        : bVal.localeCompare(aVal);
                } else {
                    return currentSort.direction === 'asc' 
                        ? aVal - bVal
                        : bVal - aVal;
                }
            });
            
            renderStudentTable(studentsToSort);
        }
        
        // Render student table (separated from filtering logic)
        function renderStudentTable(studentsToRender) {
            const tbody = document.getElementById('studentsTableBody');
            
            if (studentsToRender.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: #999;">No students found matching your criteria.</td></tr>';
                return;
            }
            
            tbody.innerHTML = studentsToRender.map(s => {
                // Check if student currently has all 3 ticket types (real-time qualification)
                const hasAllThreeTickets = s.pbisTickets > 0 && s.attendanceTickets > 0 && s.academicTickets > 0;
                
                // Generate category status indicators
                const pbisColor = s.pbisTickets > 0 ? '#ef4444' : '#e5e7eb';  // Red if has tickets, gray if not
                const attendanceColor = s.attendanceTickets > 0 ? '#10b981' : '#e5e7eb';  // Green if has tickets, gray if not
                const academicColor = s.academicTickets > 0 ? '#3b82f6' : '#e5e7eb';  // Blue if has tickets, gray if not
                
                // Determine status display
                let statusHTML = '';
                if (s.bigRaffleQualified && hasAllThreeTickets) {
                    // Officially qualified AND currently has all tickets
                    statusHTML = '<span class="qualified-badge pulse-animation" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">🏆 Locked In</span>';
                } else if (s.bigRaffleQualified) {
                    // Officially qualified but doesn't have current tickets (from previous week)
                    statusHTML = '<span class="qualified-badge" style="background: #3b82f6;">🔵 Qualified</span>';
                } else if (hasAllThreeTickets) {
                    // Currently has all tickets but not officially qualified yet
                    statusHTML = '<span class="qualified-badge pulse-animation" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);">🟢 On Track</span>';
                } else {
                    // Not qualified - show colored dots for progress
                    statusHTML = `<div style="display: inline-flex; align-items: center; gap: 6px; justify-content: center;">
                        <div style="width: 16px; height: 16px; border-radius: 50%; background: ${pbisColor}; transition: all 0.3s; box-shadow: 0 2px 4px rgba(0,0,0,0.1);" title="PBIS"></div>
                        <div style="width: 16px; height: 16px; border-radius: 50%; background: ${attendanceColor}; transition: all 0.3s; box-shadow: 0 2px 4px rgba(0,0,0,0.1);" title="Attendance"></div>
                        <div style="width: 16px; height: 16px; border-radius: 50%; background: ${academicColor}; transition: all 0.3s; box-shadow: 0 2px 4px rgba(0,0,0,0.1);" title="Academic"></div>
                    </div>`;
                }
                
                return `
                <tr>
                    <td>${s.id}</td>
                    <td>
                        <a href="javascript:void(0)" onclick="openStudentProfile('${s.id}')" 
                           style="color: #667eea; text-decoration: none; font-weight: 600; cursor: pointer; transition: color 0.2s;"
                           onmouseover="this.style.color='#764ba2'" 
                           onmouseout="this.style.color='#667eea'">
                            ${s.firstName} ${s.lastName}
                        </a>
                    </td>
                    <td>${s.grade}</td>
                    <td><span class="ticket-badge pbis">${s.pbisTickets}</span></td>
                    <td><span class="ticket-badge attendance">${s.attendanceTickets}</span></td>
                    <td><span class="ticket-badge academic">${s.academicTickets}</span></td>
                    <td>${statusHTML}</td>
                </tr>
            `;
            }).join('');
        }
        
        // Export to Excel
        function exportToExcel() {
            // Get current filtered/sorted students
            let studentsToExport = filteredStudentsCache.length > 0 ? filteredStudentsCache : students;
            if (currentGradeFilter !== 'all' && filteredStudentsCache.length === 0) {
                studentsToExport = students.filter(s => {
                    const grade = parseInt(s.grade) || 'Unknown';
                    return grade.toString() === currentGradeFilter;
                });
            }
            
            if (studentsToExport.length === 0) {
                alert('No students to export!');
                return;
            }
            
            // Create CSV content
            const headers = ['Student ID', 'First Name', 'Last Name', 'Grade', 'PBIS Tickets', 'Attendance Tickets', 'Academic Tickets', 'Total Tickets', 'Qualified for Big Raffle'];
            const csvContent = [
                headers.join(','),
                ...studentsToExport.map(s => {
                    const total = (s.pbisTickets || 0) + (s.attendanceTickets || 0) + (s.academicTickets || 0);
                    return [
                        s.id,
                        s.firstName,
                        s.lastName,
                        s.grade,
                        s.pbisTickets || 0,
                        s.attendanceTickets || 0,
                        s.academicTickets || 0,
                        total,
                        s.bigRaffleQualified ? 'Yes' : 'No'
                    ].join(',');
                })
            ].join('\n');
            
            // Download file
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', `students_week${currentWeek}_${new Date().toISOString().split('T')[0]}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            showSuccessToast('📥 Student data exported to Excel!');
        }
        
        // ============================================
        // DATA VISUALIZATION CHARTS
        // ============================================
        
        let ticketPieChart = null;
        let ticketsByGradeChart = null;
        
        function updateCharts() {
            updateTicketPieChart();
            updateTicketsByGradeChart();
        }
        
        function updateTicketPieChart() {
            const ctx = document.getElementById('ticketPieChart');
            if (!ctx) return;
            
            // Calculate totals
            let totalPBIS = 0;
            let totalAttendance = 0;
            let totalAcademic = 0;
            
            students.forEach(s => {
                totalPBIS += s.pbisTickets || 0;
                totalAttendance += s.attendanceTickets || 0;
                totalAcademic += s.academicTickets || 0;
            });
            
            // Destroy existing chart
            if (ticketPieChart) {
                ticketPieChart.destroy();
            }
            
            // Create new chart
            ticketPieChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: ['PBIS Behaviors', 'Perfect Attendance', 'Academics'],
                    datasets: [{
                        data: [totalPBIS, totalAttendance, totalAcademic],
                        backgroundColor: [
                            'rgba(102, 126, 234, 0.8)',
                            'rgba(16, 185, 129, 0.8)',
                            'rgba(59, 130, 246, 0.8)'
                        ],
                        borderColor: [
                            'rgba(102, 126, 234, 1)',
                            'rgba(16, 185, 129, 1)',
                            'rgba(59, 130, 246, 1)'
                        ],
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                padding: 15,
                                font: {
                                    size: 12
                                }
                            }
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const label = context.label || '';
                                    const value = context.parsed || 0;
                                    const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                    const percentage = ((value / total) * 100).toFixed(1);
                                    return `${label}: ${value} tickets (${percentage}%)`;
                                }
                            }
                        }
                    }
                }
            });
        }
        
        function updateTicketsByGradeChart() {
            const ctx = document.getElementById('ticketsByGradeChart');
            if (!ctx) return;
            
            // Calculate tickets by grade
            const gradeData = {};
            students.forEach(s => {
                const grade = s.grade || 'Unknown';
                if (!gradeData[grade]) {
                    gradeData[grade] = { pbis: 0, attendance: 0, academic: 0 };
                }
                gradeData[grade].pbis += s.pbisTickets || 0;
                gradeData[grade].attendance += s.attendanceTickets || 0;
                gradeData[grade].academic += s.academicTickets || 0;
            });
            
            // Sort grades
            const grades = Object.keys(gradeData).sort((a, b) => {
                const aNum = parseInt(a);
                const bNum = parseInt(b);
                if (isNaN(aNum)) return 1;
                if (isNaN(bNum)) return -1;
                return aNum - bNum;
            });
            
            // Destroy existing chart
            if (ticketsByGradeChart) {
                ticketsByGradeChart.destroy();
            }
            
            // Create new chart
            ticketsByGradeChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: grades.map(g => `Grade ${g}`),
                    datasets: [
                        {
                            label: 'PBIS',
                            data: grades.map(g => gradeData[g].pbis),
                            backgroundColor: 'rgba(102, 126, 234, 0.8)',
                            borderColor: 'rgba(102, 126, 234, 1)',
                            borderWidth: 2
                        },
                        {
                            label: 'Attendance',
                            data: grades.map(g => gradeData[g].attendance),
                            backgroundColor: 'rgba(16, 185, 129, 0.8)',
                            borderColor: 'rgba(16, 185, 129, 1)',
                            borderWidth: 2
                        },
                        {
                            label: 'Academic',
                            data: grades.map(g => gradeData[g].academic),
                            backgroundColor: 'rgba(59, 130, 246, 0.8)',
                            borderColor: 'rgba(59, 130, 246, 1)',
                            borderWidth: 2
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                stepSize: 1
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                padding: 10,
                                font: {
                                    size: 12
                                }
                            }
                        }
                    }
                }
            });
        }
        
        // ============================================
        // STUDENT PROFILE MODAL
        // ============================================
        
        function openStudentProfile(studentId) {
            const student = students.find(s => s.id === studentId);
            if (!student) {
                alert('Student not found!');
                return;
            }
            
            // Show modal
            document.getElementById('studentProfileModal').style.display = 'block';
            document.body.style.overflow = 'hidden';
            
            // Populate header
            const totalTickets = (student.pbisTickets || 0) + (student.attendanceTickets || 0) + (student.academicTickets || 0);
            const initials = `${student.firstName.charAt(0)}${student.lastName.charAt(0)}`;
            
            document.getElementById('profileHeader').innerHTML = `
                <div style="width: 100px; height: 100px; background: white; color: #667eea; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 42px; font-weight: 700; margin: 0 auto 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
                    ${initials}
                </div>
                <h2 style="margin: 0 0 10px 0; font-size: 32px;">${student.firstName} ${student.lastName}</h2>
                <div style="opacity: 0.9; font-size: 16px;">Student ID: ${student.id} • Grade ${student.grade}</div>
                ${student.bigRaffleQualified ? 
                    '<div style="margin-top: 15px; background: rgba(255,255,255,0.2); padding: 10px 20px; border-radius: 20px; display: inline-block; font-weight: 600;">🏆 Qualified for Wildcat Jackpot</div>' 
                    : ''}
            `;
            
            // Calculate badges
            const badges = [];
            const lifetimeTickets = (student.ticketHistory || []).reduce((sum, entry) => sum + (entry.amount || 1), 0);
            if (lifetimeTickets >= 100) badges.push({ emoji: '💯', label: '100+ Lifetime Tickets', color: '#f59e0b' });
            else if (lifetimeTickets >= 50) badges.push({ emoji: '⭐', label: '50+ Lifetime Tickets', color: '#3b82f6' });
            else if (lifetimeTickets >= 25) badges.push({ emoji: '🌟', label: '25+ Lifetime Tickets', color: '#10b981' });
            
            const weeksQualified = (student.ticketHistory || []).filter(entry => entry.reason && entry.reason.includes('Qualified')).length;
            if (weeksQualified >= 5) badges.push({ emoji: '🔥', label: '5-Week Streak', color: '#ef4444' });
            if ((student.attendanceTickets || 0) >= 5) badges.push({ emoji: '📅', label: 'Perfect Attendance', color: '#10b981' });
            if (totalTickets >= 5) badges.push({ emoji: '🎯', label: 'Weekly Goal Achieved', color: '#667eea' });
            
            if (badges.length > 0) {
                document.getElementById('profileBadges').innerHTML = `
                    <h3 style="margin: 0 0 15px 0; color: #333; font-size: 18px;">🏅 Achievements</h3>
                    <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                        ${badges.map(badge => `
                            <div style="background: ${badge.color}; color: white; padding: 12px 20px; border-radius: 25px; font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                                <span style="font-size: 20px;">${badge.emoji}</span>
                                ${badge.label}
                            </div>
                        `).join('')}
                    </div>
                `;
            } else {
                document.getElementById('profileBadges').innerHTML = '<div style="text-align: center; padding: 20px; color: #999; font-style: italic;">Keep earning tickets to unlock achievements! 🌟</div>';
            }
            
            document.getElementById('profileTotalTickets').textContent = totalTickets;
            document.getElementById('profileWeeksQualified').textContent = weeksQualified;
            document.getElementById('profileLifetimeTickets').textContent = lifetimeTickets;
            
            // Add behavior referral count if superadmin
            const studentReferrals = behaviorReferrals.filter(r => r.studentId === studentId);
            if (currentUser && currentUser.role === 'superadmin' && studentReferrals.length > 0) {
                // Add referral count to stats
                const statsGrid = document.querySelector('#studentProfileModal .content > div:nth-child(2)');
                if (statsGrid) {
                    statsGrid.innerHTML += `
                        <div style="background: #fef3c7; padding: 20px; border-radius: 12px; text-align: center; border: 2px solid #f59e0b;">
                            <div style="font-size: 36px; font-weight: 700; color: #d97706;" id="profileReferralCount">${studentReferrals.length}</div>
                            <div style="color: #92400e; font-size: 14px; margin-top: 5px;">Behavior Referrals</div>
                        </div>
                    `;
                }
            }
            
            const history = student.ticketHistory || [];
            if (history.length > 0) {
                document.getElementById('profileTicketHistory').innerHTML = history.slice().reverse().map(entry => {
                    const date = new Date(entry.timestamp).toLocaleDateString();
                    const time = new Date(entry.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    let icon = '🎫', bgColor = '#f3f4f6';
                    if (entry.category === 'pbis') { icon = '🎯'; bgColor = 'rgba(102, 126, 234, 0.1)'; }
                    else if (entry.category === 'attendance') { icon = '📅'; bgColor = 'rgba(16, 185, 129, 0.1)'; }
                    else if (entry.category === 'academics') { icon = '📚'; bgColor = 'rgba(59, 130, 246, 0.1)'; }
                    
                    return `
                        <div style="background: ${bgColor}; padding: 15px; border-radius: 8px; margin-bottom: 12px; border-left: 4px solid #667eea;">
                            <div style="display: flex; justify-content: space-between; align-items: start;">
                                <div style="display: flex; align-items: center; gap: 10px;">
                                    <span style="font-size: 24px;">${icon}</span>
                                    <div>
                                        <div style="font-weight: 600; color: #333;">${entry.reason || 'Ticket Awarded'}</div>
                                        <div style="font-size: 13px; color: #666; margin-top: 3px;">${date} at ${time} • by ${entry.teacher || 'Teacher'}</div>
                                    </div>
                                </div>
                                <div style="background: #667eea; color: white; padding: 4px 12px; border-radius: 12px; font-weight: 600; font-size: 14px;">+${entry.amount || 1}</div>
                            </div>
                        </div>
                    `;
                }).join('');
            } else {
                document.getElementById('profileTicketHistory').innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">No ticket history yet. Start earning tickets! 🎟️</div>';
            }
        }
        
        function closeStudentProfile() {
            document.getElementById('studentProfileModal').style.display = 'none';
            document.body.style.overflow = 'auto';
        }
        
        document.addEventListener('click', function(event) {
            const modal = document.getElementById('studentProfileModal');
            if (event.target === modal) closeStudentProfile();
        });
        
        // ============================================
        // SCHOOL BRANDING FUNCTIONS
        // ============================================
        
        function handleLogoUpload(input) {
            const file = input.files[0];
            if (!file) return;
            
            // Check file size (max 500KB)
            if (file.size > 500000) {
                alert('⚠️ Logo file is too large!\n\nPlease use an image under 500KB.');
                input.value = '';
                return;
            }
            
            // Convert to base64
            const reader = new FileReader();
            reader.onload = function(e) {
                const logoPreview = document.getElementById('logoPreview');
                const logoPreviewImg = document.getElementById('logoPreviewImg');
                
                logoPreviewImg.src = e.target.result;
                logoPreview.style.display = 'flex';
                logoPreview.style.alignItems = 'center';
                logoPreview.style.gap = '10px';
                
                // Store in temp (not saved until Save Branding clicked)
                schoolBranding.logoBase64 = e.target.result;
            };
            reader.readAsDataURL(file);
        }
        
        function removeLogo() {
            document.getElementById('brandingLogoUpload').value = '';
            document.getElementById('logoPreview').style.display = 'none';
            schoolBranding.logoBase64 = '';
        }
        
        // Sync color picker with hex input
        document.addEventListener('DOMContentLoaded', function() {
            const colorInputs = [
                {picker: 'brandingPrimaryColor', hex: 'brandingPrimaryColorHex'},
                {picker: 'brandingSecondaryColor', hex: 'brandingSecondaryColorHex'},
                {picker: 'brandingAccentColor', hex: 'brandingAccentColorHex'}
            ];
            
            colorInputs.forEach(({picker, hex}) => {
                const pickerEl = document.getElementById(picker);
                const hexEl = document.getElementById(hex);
                
                if (pickerEl && hexEl) {
                    pickerEl.addEventListener('input', (e) => {
                        hexEl.value = e.target.value;
                    });
                    
                    hexEl.addEventListener('input', (e) => {
                        if (/^#[0-9A-F]{6}$/i.test(e.target.value)) {
                            pickerEl.value = e.target.value;
                        }
                    });
                }
            });
        });
        
        function previewBranding() {
            // Get values from inputs
            const tempBranding = {
                schoolName: document.getElementById('brandingSchoolName').value,
                mascot: document.getElementById('brandingMascot').value || 'Wildcat',
                logoBase64: schoolBranding.logoBase64,
                colors: {
                    primary: document.getElementById('brandingPrimaryColor').value,
                    secondary: document.getElementById('brandingSecondaryColor').value,
                    accent: document.getElementById('brandingAccentColor').value
                },
                terminology: {
                    cashName: document.getElementById('brandingCashName').value || 'Wildcat Cash',
                    jackpotName: document.getElementById('brandingJackpotName').value || 'Wildcat Jackpot',
                    passName: document.getElementById('brandingPassName').value || 'ClawPass'
                }
            };
            
            // Apply temporarily
            applyBranding(tempBranding);
            
            showSuccessToast('👁️ Preview applied! Click "Save Branding" to make it permanent.');
        }
        
        function saveBranding() {
            const confirm = window.confirm(
                '💾 Save School Branding\n\n' +
                'This will apply your custom branding to the entire system for ALL users.\n\n' +
                'Are you sure you want to save these changes?'
            );
            
            if (!confirm) return;
            
            // Update global branding object
            schoolBranding = {
                schoolName: document.getElementById('brandingSchoolName').value,
                mascot: document.getElementById('brandingMascot').value || 'Wildcat',
                logoBase64: schoolBranding.logoBase64,
                colors: {
                    primary: document.getElementById('brandingPrimaryColor').value,
                    secondary: document.getElementById('brandingSecondaryColor').value,
                    accent: document.getElementById('brandingAccentColor').value
                },
                terminology: {
                    cashName: document.getElementById('brandingCashName').value || 'Wildcat Cash',
                    jackpotName: document.getElementById('brandingJackpotName').value || 'Wildcat Jackpot',
                    passName: document.getElementById('brandingPassName').value || 'ClawPass'
                }
            };
            
            // Apply branding
            applyBranding(schoolBranding);
            
            // Save to database
            saveData();
            
            showSuccessToast('✅ School branding saved successfully!');
        }
        
        function resetBrandingToDefault() {
            const confirm = window.confirm(
                '🔄 Reset to Default Branding\n\n' +
                'This will remove all custom branding and restore the default Wildcat theme.\n\n' +
                'Are you sure you want to reset?'
            );
            
            if (!confirm) return;
            
            // Reset to defaults
            schoolBranding = {
                schoolName: '',
                mascot: 'Wildcat',
                logoBase64: '',
                colors: {
                    primary: '#667eea',
                    secondary: '#764ba2',
                    accent: '#10b981'
                },
                terminology: {
                    cashName: 'Wildcat Cash',
                    jackpotName: 'Wildcat Jackpot',
                    passName: 'ClawPass'
                }
            };
            
            // Clear form fields
            document.getElementById('brandingSchoolName').value = '';
            document.getElementById('brandingMascot').value = 'Wildcat';
            document.getElementById('brandingPrimaryColor').value = '#667eea';
            document.getElementById('brandingPrimaryColorHex').value = '#667eea';
            document.getElementById('brandingSecondaryColor').value = '#764ba2';
            document.getElementById('brandingSecondaryColorHex').value = '#764ba2';
            document.getElementById('brandingAccentColor').value = '#10b981';
            document.getElementById('brandingAccentColorHex').value = '#10b981';
            document.getElementById('brandingCashName').value = '';
            document.getElementById('brandingJackpotName').value = '';
            document.getElementById('brandingPassName').value = '';
            
            // Remove logo
            removeLogo();
            
            // Apply default branding
            applyBranding(schoolBranding);
            
            // Save to database
            saveData();
            
            showSuccessToast('✅ Branding reset to default!');
            
            // Reload page to ensure everything is back to normal
            setTimeout(() => {
                location.reload();
            }, 1500);
        }
        
        function applyBranding(branding) {
            console.log('🎨 Applying branding:', branding);
            
            // Apply colors via CSS variables
            document.documentElement.style.setProperty('--brand-primary', branding.colors.primary);
            document.documentElement.style.setProperty('--brand-secondary', branding.colors.secondary);
            document.documentElement.style.setProperty('--brand-accent', branding.colors.accent);
            
            // Update ALL gradient backgrounds (inline styles)
            const gradients = document.querySelectorAll('[style*="linear-gradient"]');
            gradients.forEach(el => {
                const currentStyle = el.getAttribute('style');
                if (currentStyle && (currentStyle.includes('667eea') || currentStyle.includes('764ba2'))) {
                    const newStyle = currentStyle
                        .replace(/667eea/g, branding.colors.primary.replace('#', ''))
                        .replace(/764ba2/g, branding.colors.secondary.replace('#', ''));
                    el.setAttribute('style', newStyle);
                }
            });
            
            // Update all buttons with gradient class
            document.querySelectorAll('.btn-gradient').forEach(btn => {
                btn.style.background = `linear-gradient(135deg, ${branding.colors.primary} 0%, ${branding.colors.secondary} 100%)`;
            });
            
            // Update dashboard stat cards gradient borders
            document.querySelectorAll('.dashboard-stat-card').forEach(card => {
                if (card.querySelector('::before')) {
                    const style = document.createElement('style');
                    style.textContent = `.dashboard-stat-card::before { background: linear-gradient(90deg, ${branding.colors.primary} 0%, ${branding.colors.secondary} 100%) !important; }`;
                    document.head.appendChild(style);
                }
            });
            
            // Update enhanced table header
            document.querySelectorAll('.enhanced-table thead').forEach(thead => {
                thead.style.background = `linear-gradient(135deg, ${branding.colors.primary} 0%, ${branding.colors.secondary} 100%)`;
            });
            
            // Update ticket badges colors
            document.querySelectorAll('.ticket-badge.pbis').forEach(badge => {
                badge.style.background = `linear-gradient(135deg, ${branding.colors.primary} 0%, ${branding.colors.secondary} 100%)`;
            });
            
            // Update school name in header (if exists)
            const headerTitle = document.querySelector('h1');
            if (headerTitle && branding.schoolName) {
                if (!headerTitle.dataset.originalText) {
                    headerTitle.dataset.originalText = headerTitle.textContent;
                }
                headerTitle.textContent = branding.schoolName;
            }
            
            // Replace terminology throughout page
            replaceTerminology(branding.terminology);
            
            // Apply logo if exists
            if (branding.logoBase64) {
                applyLogo(branding.logoBase64);
            }
            
            console.log('✅ Branding applied successfully!');
        }
        
        function replaceTerminology(terminology) {
            // This will be called to replace text throughout the page
            // For now, we'll update specific known elements
            // In production, you'd want to be more selective to avoid breaking things
            
            // Update mode toggle if exists
            const cashModeLabel = document.querySelector('[onclick="toggleMode(true)"]');
            if (cashModeLabel) {
                cashModeLabel.innerHTML = cashModeLabel.innerHTML.replace('Wildcat Cash', terminology.cashName);
            }
            
            // Update jackpot references
            document.querySelectorAll('*').forEach(el => {
                if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) { // Text node only
                    let text = el.textContent;
                    if (text.includes('Wildcat Jackpot')) {
                        el.textContent = text.replace(/Wildcat Jackpot/g, terminology.jackpotName);
                    }
                    if (text.includes('Wildcat Cash')) {
                        el.textContent = text.replace(/Wildcat Cash/g, terminology.cashName);
                    }
                    if (text.includes('ClawPass')) {
                        el.textContent = text.replace(/ClawPass/g, terminology.passName);
                    }
                }
            });
        }
        
        function applyLogo(logoBase64) {
            // Add logo to header
            let logoContainer = document.getElementById('schoolLogoContainer');
            if (!logoContainer) {
                logoContainer = document.createElement('div');
                logoContainer.id = 'schoolLogoContainer';
                logoContainer.style.cssText = 'position: absolute; top: 20px; left: 20px; z-index: 1000;';
                document.body.appendChild(logoContainer);
            }
            
            logoContainer.innerHTML = `<img src="${logoBase64}" alt="School Logo" style="max-height: 60px; max-width: 150px;">`;
        }
        
        function loadBrandingSettings() {
            // Load branding into form fields
            if (schoolBranding) {
                document.getElementById('brandingSchoolName').value = schoolBranding.schoolName || '';
                document.getElementById('brandingMascot').value = schoolBranding.mascot || 'Wildcat';
                document.getElementById('brandingPrimaryColor').value = schoolBranding.colors.primary;
                document.getElementById('brandingPrimaryColorHex').value = schoolBranding.colors.primary;
                document.getElementById('brandingSecondaryColor').value = schoolBranding.colors.secondary;
                document.getElementById('brandingSecondaryColorHex').value = schoolBranding.colors.secondary;
                document.getElementById('brandingAccentColor').value = schoolBranding.colors.accent;
                document.getElementById('brandingAccentColorHex').value = schoolBranding.colors.accent;
                document.getElementById('brandingCashName').value = schoolBranding.terminology.cashName !== 'Wildcat Cash' ? schoolBranding.terminology.cashName : '';
                document.getElementById('brandingJackpotName').value = schoolBranding.terminology.jackpotName !== 'Wildcat Jackpot' ? schoolBranding.terminology.jackpotName : '';
                document.getElementById('brandingPassName').value = schoolBranding.terminology.passName !== 'ClawPass' ? schoolBranding.terminology.passName : '';
                
                // Show logo preview if exists
                if (schoolBranding.logoBase64) {
                    document.getElementById('logoPreviewImg').src = schoolBranding.logoBase64;
                    document.getElementById('logoPreview').style.display = 'flex';
                    document.getElementById('logoPreview').style.alignItems = 'center';
                    document.getElementById('logoPreview').style.gap = '10px';
                }
                
                // Apply branding
                applyBranding(schoolBranding);
            }
        }
        
        
        function setStudentView(viewType) {
            currentStudentView = viewType;
            
            // Update button styles
            const gradeBtn = document.getElementById('viewByGradeBtn');
            const allBtn = document.getElementById('viewAllBtn');
            
            if (viewType === 'grade') {
                gradeBtn.style.background = '#667eea';
                gradeBtn.classList.remove('btn-secondary');
                allBtn.style.background = '#6c757d';
                allBtn.classList.add('btn-secondary');
                
                document.getElementById('studentsGroupedView').style.display = 'block';
                document.getElementById('studentsTableView').style.display = 'none';
                updateGroupedStudentView();
            } else {
                allBtn.style.background = '#667eea';
                allBtn.classList.remove('btn-secondary');
                gradeBtn.style.background = '#6c757d';
                gradeBtn.classList.add('btn-secondary');
                
                document.getElementById('studentsGroupedView').style.display = 'none';
                document.getElementById('studentsTableView').style.display = 'block';
                updateStudentsTable();
            }
        }
        
        function updateGroupedStudentView() {
            const container = document.getElementById('studentsGroupedView');
            
            if (students.length === 0) {
                container.innerHTML = '<p style="text-align: center; padding: 40px; color: #999;">No students loaded. Upload a file to get started!</p>';
                return;
            }
            
            // Group students by grade and period
            const gradeGroups = {};
            
            students.forEach(student => {
                const grade = parseInt(student.grade) || 'Unknown';
                
                if (!gradeGroups[grade]) {
                    gradeGroups[grade] = {
                        students: [],
                        periods: {}
                    };
                }
                
                // Find which periods/classes this student is in
                let studentPeriods = [];
                teachers.forEach(teacher => {
                    if (teacher.sections) {
                        teacher.sections.forEach(section => {
                            if (section.students && section.students.some(s => s.id === student.id)) {
                                const periodKey = `Period ${section.period} - ${section.courseName}`;
                                studentPeriods.push({
                                    key: periodKey,
                                    period: section.period,
                                    course: section.courseName
                                });
                            }
                        });
                    }
                });
                
                // Add student to each period they're in
                if (studentPeriods.length === 0) {
                    // Student not in any period - add to "No Period Assigned"
                    const noPeriodKey = 'No Period Assigned';
                    if (!gradeGroups[grade].periods[noPeriodKey]) {
                        gradeGroups[grade].periods[noPeriodKey] = [];
                    }
                    gradeGroups[grade].periods[noPeriodKey].push(student);
                } else {
                    studentPeriods.forEach(periodInfo => {
                        if (!gradeGroups[grade].periods[periodInfo.key]) {
                            gradeGroups[grade].periods[periodInfo.key] = [];
                        }
                        gradeGroups[grade].periods[periodInfo.key].push(student);
                    });
                }
                
                gradeGroups[grade].students.push(student);
            });
            
            // Handle mixed-grade classes
            // Find all classes and determine their primary grade
            const allClasses = {};
            teachers.forEach(teacher => {
                if (teacher.sections) {
                    teacher.sections.forEach(section => {
                        const classKey = `Period ${section.period} - ${section.courseName}`;
                        if (!allClasses[classKey]) {
                            allClasses[classKey] = {
                                period: section.period,
                                course: section.courseName,
                                grades: {}
                            };
                        }
                        
                        // Count students by grade in this class
                        section.students.forEach(sectionStudent => {
                            const student = students.find(s => s.id === sectionStudent.id);
                            if (student) {
                                const grade = parseInt(student.grade) || 'Unknown';
                                allClasses[classKey].grades[grade] = (allClasses[classKey].grades[grade] || 0) + 1;
                            }
                        });
                    });
                }
            });
            
            // Sort grades
            let sortedGrades = Object.keys(gradeGroups).sort((a, b) => {
                if (a === 'Unknown') return 1;
                if (b === 'Unknown') return -1;
                return parseInt(a) - parseInt(b);
            });
            
            // Filter by selected grade if not "all"
            if (currentGradeFilter !== 'all') {
                sortedGrades = sortedGrades.filter(grade => grade === currentGradeFilter);
            }
            
            // Build HTML
            let html = '';
            
            if (sortedGrades.length === 0) {
                html = '<p style="text-align: center; padding: 40px; color: #999;">No students found for the selected grade level.</p>';
                container.innerHTML = html;
                return;
            }
            
            sortedGrades.forEach(grade => {
                const gradeData = gradeGroups[grade];
                const gradeLabel = grade === 'Unknown' ? 'Unknown Grade' : `Grade ${grade}`;
                const gradeColor = grade === '6' ? '#2196F3' : 
                                  grade === '7' ? '#4CAF50' : 
                                  grade === '8' ? '#FF9800' :
                                  grade === '9' ? '#9C27B0' :
                                  grade === '10' ? '#F44336' :
                                  grade === '11' ? '#00BCD4' :
                                  grade === '12' ? '#FF5722' : '#607D8B';
                
                html += `
                    <div style="margin-bottom: 30px; border: 2px solid ${gradeColor}; border-radius: 8px; overflow: hidden;">
                        <div style="background: ${gradeColor}; color: white; padding: 15px;">
                            <h3 style="margin: 0; display: flex; justify-content: space-between; align-items: center;">
                                <span>📚 ${gradeLabel}</span>
                                <span style="font-size: 16px; font-weight: normal;">${gradeData.students.length} student${gradeData.students.length !== 1 ? 's' : ''}</span>
                            </h3>
                        </div>
                        <div style="padding: 20px; background: white;">
                `;
                
                // Sort periods
                const sortedPeriods = Object.keys(gradeData.periods).sort((a, b) => {
                    if (a === 'No Period Assigned') return 1;
                    if (b === 'No Period Assigned') return -1;
                    return a.localeCompare(b);
                });
                
                sortedPeriods.forEach(periodKey => {
                    const periodStudents = gradeData.periods[periodKey];
                    
                    html += `
                        <div style="margin-bottom: 20px;">
                            <h4 style="color: #666; margin-bottom: 10px; padding: 8px; background: #f5f5f5; border-radius: 4px;">
                                ${periodKey} <span style="font-weight: normal; font-size: 14px;">(${periodStudents.length} student${periodStudents.length !== 1 ? 's' : ''})</span>
                            </h4>
                            <div style="overflow-x: auto;">
                                <table style="width: 100%; border-collapse: collapse;">
                                    <thead>
                                        <tr style="background: #f9f9f9; border-bottom: 2px solid #ddd;">
                                            <th style="padding: 8px; text-align: left;">Student ID</th>
                                            <th style="padding: 8px; text-align: left;">Name</th>
                                            <th style="padding: 8px; text-align: center;">PBIS</th>
                                            <th style="padding: 8px; text-align: center;">Attendance</th>
                                            <th style="padding: 8px; text-align: center;">Academic</th>
                                            <th style="padding: 8px; text-align: center;">Jackpot</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                    `;
                    
                    // Sort students alphabetically
                    periodStudents.sort((a, b) => {
                        const nameA = `${a.lastName}, ${a.firstName}`.toLowerCase();
                        const nameB = `${b.lastName}, ${b.firstName}`.toLowerCase();
                        return nameA.localeCompare(nameB);
                    });
                    
                    periodStudents.forEach(student => {
                        html += `
                            <tr style="border-bottom: 1px solid #eee;">
                                <td style="padding: 8px;">${student.id}</td>
                                <td style="padding: 8px;">${student.firstName} ${student.lastName}</td>
                                <td style="padding: 8px; text-align: center; font-weight: bold; color: #667eea;">${student.pbisTickets}</td>
                                <td style="padding: 8px; text-align: center; font-weight: bold; color: #28a745;">${student.attendanceTickets}</td>
                                <td style="padding: 8px; text-align: center; font-weight: bold; color: #ffc107;">${student.academicTickets}</td>
                                <td style="padding: 8px; text-align: center;">${student.bigRaffleQualified ? '<span style="color: #28a745; font-weight: bold;">✓ Qualified</span>' : '<span style="color: #999;">-</span>'}</td>
                            </tr>
                        `;
                    });
                    
                    html += `
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    `;
                });
                
                html += `
                        </div>
                    </div>
                `;
            });
            
            container.innerHTML = html;
        }

        function updateTicketsTable() {
            const tbody = document.getElementById('ticketsTableBody');
            const periodFilter = document.getElementById('periodFilter');
            const gradeFilter = document.getElementById('gradeFilter');
            const selectedPeriod = periodFilter ? periodFilter.value : '';
            const selectedGrade = gradeFilter ? gradeFilter.value : '';
            
            console.log('=== UPDATE TICKETS TABLE ===');
            console.log('Selected period:', selectedPeriod);
            console.log('Selected grade:', selectedGrade);
            
            // Update dynamic header
            const classHeader = document.getElementById('classHeader');
            const classHeaderTitle = document.getElementById('classHeaderTitle');
            const classHeaderSubtitle = document.getElementById('classHeaderSubtitle');
            const classHeaderCount = document.getElementById('classHeaderCount');
            
            let displayStudents = students;
            let headerTitle = 'All Students';
            let headerSubtitle = 'Select students to award tickets';
            
            // Filter by period if selected (but NOT for Campus Aides - they see all students)
            if (selectedPeriod && currentUser && currentUser.sections && currentUser.role !== 'campusaide') {
                console.log('Filtering by selected period...');
                const section = currentUser.sections.find(s => s.sectionId === selectedPeriod);
                if (section) {
                    console.log('Found section:', section);
                    displayStudents = students.filter(s => section.students.includes(s.id));
                    headerTitle = `Period ${section.period} - ${section.courseName}`;
                    headerSubtitle = `${section.students.length} students in this class`;
                    console.log('Filtered to', displayStudents.length, 'students');
                } else {
                    console.log('Section not found!');
                }
            } else if (currentUser && currentUser.role === 'campusaide') {
                // Campus Aides can filter by grade
                if (selectedGrade) {
                    displayStudents = students.filter(s => s.grade == selectedGrade);
                    headerTitle = `Grade ${selectedGrade} (Campus Aide)`;
                    headerSubtitle = `${displayStudents.length} students in grade ${selectedGrade}`;
                } else {
                    headerTitle = 'All Students (Campus Aide)';
                    headerSubtitle = 'You have access to all students';
                }
            }
            
            console.log('Displaying', displayStudents.length, 'students');
            
            // Show/update header
            if (classHeader) {
                classHeader.style.display = 'block';
                if (classHeaderTitle) classHeaderTitle.textContent = headerTitle;
                if (classHeaderSubtitle) classHeaderSubtitle.textContent = headerSubtitle;
                if (classHeaderCount) classHeaderCount.textContent = displayStudents.length;
            }
            
            // Render table with better styling
            tbody.innerHTML = displayStudents.map((s, index) => {
                const rowBg = index % 2 === 0 ? '#f9f9f9' : 'white';
                
                // Generate category status indicators
                const pbisColor = s.pbisTickets > 0 ? '#ef4444' : '#e5e7eb';  // Red if has tickets, gray if not
                const attendanceColor = s.attendanceTickets > 0 ? '#10b981' : '#e5e7eb';  // Green if has tickets, gray if not
                const academicColor = s.academicTickets > 0 ? '#3b82f6' : '#e5e7eb';  // Blue if has tickets, gray if not
                
                return `
                <tr style="background: ${rowBg}; transition: all 0.2s; border-bottom: 1px solid #eee;" 
                    onmouseover="this.style.background='#e8f4ff'; this.style.transform='scale(1.01)'" 
                    onmouseout="this.style.background='${rowBg}'; this.style.transform='scale(1)'">
                    <td class="checkbox-cell" style="padding: 12px; border: none;">
                        <input type="checkbox" class="student-checkbox" data-id="${s.id}" style="cursor: pointer; width: 18px; height: 18px;">
                    </td>
                    <td style="padding: 12px; border: none; color: #666; font-size: 14px;">${s.id}</td>
                    <td style="padding: 12px; border: none;">
                        <a href="javascript:void(0)" onclick="openStudentProfile('${s.id}')" 
                           style="color: #667eea; text-decoration: none; font-weight: 600; cursor: pointer; transition: color 0.2s; font-size: 14px;"
                           onmouseover="this.style.color='#764ba2'" 
                           onmouseout="this.style.color='#667eea'">
                            ${s.firstName} ${s.lastName}
                        </a>
                    </td>
                    <td style="padding: 12px; border: none; text-align: center;">
                        <span style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 700; font-size: 14px; display: inline-block; min-width: 35px;">${s.pbisTickets}</span>
                    </td>
                    <td style="padding: 12px; border: none; text-align: center;">
                        <span style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 700; font-size: 14px; display: inline-block; min-width: 35px;">${s.attendanceTickets}</span>
                    </td>
                    <td style="padding: 12px; border: none; text-align: center;">
                        <span style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 700; font-size: 14px; display: inline-block; min-width: 35px;">${s.academicTickets}</span>
                    </td>
                    <td style="padding: 12px; border: none; text-align: center;">
                        ${s.bigRaffleQualified ? 
                            '<span class="qualified-badge pulse-animation">✓ Qualified</span>' : 
                            `<div style="display: inline-flex; align-items: center; gap: 6px; justify-content: center;">
                                <div style="width: 16px; height: 16px; border-radius: 50%; background: ${pbisColor}; transition: all 0.3s; box-shadow: 0 2px 4px rgba(0,0,0,0.1);" title="PBIS"></div>
                                <div style="width: 16px; height: 16px; border-radius: 50%; background: ${attendanceColor}; transition: all 0.3s; box-shadow: 0 2px 4px rgba(0,0,0,0.1);" title="Attendance"></div>
                                <div style="width: 16px; height: 16px; border-radius: 50%; background: ${academicColor}; transition: all 0.3s; box-shadow: 0 2px 4px rgba(0,0,0,0.1);" title="Academic"></div>
                            </div>`
                        }
                    </td>
                </tr>
            `;
            }).join('');
        }
        
        function updatePeriodFilter() {
            const periodFilterSection = document.getElementById('periodFilterSection');
            const periodFilter = document.getElementById('periodFilter');
            
            console.log('=== UPDATE PERIOD FILTER ===');
            console.log('User role:', currentUser?.role);
            console.log('User sections:', currentUser?.sections);
            
            // Campus Aides see all students - show grade filter
            if (currentUser && currentUser.role === 'campusaide') {
                console.log('Campus Aide - showing grade filter');
                if (periodFilterSection) {
                    periodFilterSection.style.display = 'block';
                    
                    // Get unique grades from all students
                    const uniqueGrades = [...new Set(students.map(s => s.grade))].sort((a, b) => a - b);
                    
                    periodFilterSection.innerHTML = `
                        <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 20px; border-radius: 12px; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.3);">
                            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
                                <span style="font-size: 28px;">👁️</span>
                                <h3 style="color: white; margin: 0; font-size: 18px;">Campus Aide Access</h3>
                            </div>
                            <p style="color: rgba(255,255,255,0.95); font-size: 14px; margin: 0 0 15px 0; font-weight: 500;">
                                ✓ You have access to all ${students.length} students
                            </p>
                            <div style="display: flex; gap: 10px; align-items: center;">
                                <label style="color: white; font-weight: 600; font-size: 14px;">Filter by Grade:</label>
                                <select id="gradeFilter" onchange="updateTicketsTable()" style="padding: 8px 12px; border-radius: 8px; border: 2px solid rgba(255,255,255,0.3); background: white; font-size: 14px; cursor: pointer; min-width: 150px;">
                                    <option value="">All Grades</option>
                                    ${uniqueGrades.map(grade => `<option value="${grade}">Grade ${grade}</option>`).join('')}
                                </select>
                            </div>
                        </div>
                    `;
                }
                return;
            }
            
            if (!currentUser || !currentUser.sections || currentUser.sections.length === 0) {
                console.log('No sections for this user - hiding period filter');
                if (periodFilterSection) periodFilterSection.style.display = 'none';
                return;
            }
            
            // Show filter section
            if (periodFilterSection) periodFilterSection.style.display = 'block';
            
            // Build dropdown options with proper ordering
            if (periodFilter) {
                const totalStudents = students.length;
                periodFilter.innerHTML = `<option value="">All Students (${totalStudents})</option>`;
                
                // Define correct period order
                const periodOrder = ['A1', 'P1', 'P2', 'P3', 'P4', 'HPU', 'P5', 'P6', 'A2'];
                
                // Sort sections by period order
                const sortedSections = [...currentUser.sections].sort((a, b) => {
                    const indexA = periodOrder.indexOf(a.period);
                    const indexB = periodOrder.indexOf(b.period);
                    
                    // If period not in order list, put at end
                    if (indexA === -1) return 1;
                    if (indexB === -1) return -1;
                    
                    return indexA - indexB;
                });
                
                sortedSections.forEach(section => {
                    const studentCount = section.students ? section.students.length : 0;
                    const option = document.createElement('option');
                    option.value = section.sectionId;
                    option.textContent = `Period ${section.period} - ${section.courseName} (${studentCount} students)`;
                    periodFilter.appendChild(option);
                });
                
                console.log('Dropdown populated with', sortedSections.length, 'periods');
            }
        }
        
        function filterByPeriod() {
            updateTicketsTable();
            
            // Show indicator of what's filtered
            const periodFilter = document.getElementById('periodFilter');
            if (periodFilter && periodFilter.value) {
                const selectedOption = periodFilter.options[periodFilter.selectedIndex];
                console.log('Filtering by:', selectedOption.textContent);
            }
        }

        function updateStats() {
            document.getElementById('totalStudents').textContent = students.length;
            const qualified = students.filter(s => s.bigRaffleQualified).length;
            document.getElementById('qualifiedStudents').textContent = qualified;
            document.getElementById('bigRaffleQualified').textContent = qualified;
        }

        function updateBigRaffleTable() {
            const tbody = document.getElementById('bigRaffleTable');
            const qualified = students.filter(s => s.bigRaffleQualified);
            
            if (qualified.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px; color: #999;">No students qualified yet</td></tr>';
                return;
            }

            tbody.innerHTML = qualified.map(s => `
                <tr>
                    <td>${s.id}</td>
                    <td>${s.firstName} ${s.lastName}</td>
                    <td>${s.weeksQualified}</td>
                    <td>${s.weeksQualified} ${s.weeksQualified === 1 ? 'entry' : 'entries'}</td>
                </tr>
            `).join('');
        }


        function searchTicketsTable() {
            const search = document.getElementById('searchTickets').value.toLowerCase();
            const rows = document.querySelectorAll('#ticketsTableBody tr');
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(search) ? '' : 'none';
            });
        }

        function toggleSelectAll() {
            const selectAll = document.getElementById('selectAll');
            const checkboxes = document.querySelectorAll('.student-checkbox');
            checkboxes.forEach(cb => cb.checked = selectAll.checked);
        }

        // ============================================
        // UPDATE RAFFLE DASHBOARD STATS
        // ============================================
        function updateDashboardStats() {
            // Calculate total tickets awarded this week
            let totalTickets = 0;
            students.forEach(s => {
                totalTickets += (s.pbisTickets || 0) + (s.attendanceTickets || 0) + (s.academicTickets || 0);
            });
            
            // Count qualified students
            const qualifiedCount = students.filter(s => s.bigRaffleQualified).length;
            
            // Find top earner
            let topEarner = { name: '-', total: 0 };
            students.forEach(s => {
                const studentTotal = (s.pbisTickets || 0) + (s.attendanceTickets || 0) + (s.academicTickets || 0);
                if (studentTotal > topEarner.total) {
                    topEarner = {
                        name: `${s.firstName} ${s.lastName}`,
                        total: studentTotal
                    };
                }
            });
            
            // Calculate tickets awarded by current user
            let yourTickets = 0;
            if (currentUser && currentUser.email) {
                students.forEach(s => {
                    if (s.ticketHistory && Array.isArray(s.ticketHistory)) {
                        s.ticketHistory.forEach(entry => {
                            if (entry.awardedBy === currentUser.email) {
                                yourTickets += entry.amount || 1;
                            }
                        });
                    }
                });
            }
            
            // Update dashboard elements
            const dashTotalTickets = document.getElementById('dashTotalTickets');
            const dashQualifiedStudents = document.getElementById('dashQualifiedStudents');
            const dashTopEarner = document.getElementById('dashTopEarner');
            const dashYourTickets = document.getElementById('dashYourTickets');
            
            if (dashTotalTickets) {
                dashTotalTickets.textContent = totalTickets;
                dashTotalTickets.classList.add('animated');
            }
            
            if (dashQualifiedStudents) {
                dashQualifiedStudents.textContent = qualifiedCount;
                dashQualifiedStudents.classList.add('animated');
            }
            
            if (dashTopEarner) {
                dashTopEarner.textContent = topEarner.total > 0 ? `${topEarner.name.split(' ')[0]} (${topEarner.total})` : '-';
                dashTopEarner.classList.add('animated');
                dashTopEarner.style.fontSize = topEarner.total > 0 ? '28px' : '42px';
            }
            
            if (dashYourTickets) {
                dashYourTickets.textContent = yourTickets;
                dashYourTickets.classList.add('animated');
            }
            
            // Update charts
            updateCharts();
        }

        function awardTicketsToSelected() {
            const category = document.getElementById('categorySelect').value;
            const amount = parseInt(document.getElementById('ticketAmount').value);
            const reason = document.getElementById('ticketReason').value.trim();
            const subcategory = document.getElementById('subcategorySelect').value;
            const checkboxes = document.querySelectorAll('.student-checkbox:checked');
            
            // Validate ticket amount
            if (isNaN(amount) || amount < 1 || amount > 5) {
                alert('⚠️ Invalid ticket amount!\n\nYou must award between 1 and 5 tickets.');
                document.getElementById('ticketAmount').value = 1; // Reset to default
                return;
            }
            
            if (checkboxes.length === 0) {
                alert('Please select at least one student!');
                return;
            }

            // Require subcategory for PBIS and Academics
            if ((category === 'pbis' || category === 'academics') && !subcategory) {
                alert('Please select a subcategory!');
                return;
            }

            // Require reason for PBIS and Academics
            if ((category === 'pbis' || category === 'academics') && !reason) {
                alert('Please provide a reason for this ticket award!');
                return;
            }

            const categoryName = category === 'pbis' ? 'PBIS' : 
                                category === 'attendance' ? 'Attendance' : 'Academics';

            // Track this award for UNDO functionality
            const awardedStudents = [];

            checkboxes.forEach(cb => {
                const studentId = cb.dataset.id;
                const student = students.find(s => s.id === studentId);
                if (student) {
                    // Store current state before awarding
                    const previousState = {
                        studentId: student.id,
                        pbisTickets: student.pbisTickets,
                        attendanceTickets: student.attendanceTickets,
                        academicTickets: student.academicTickets,
                        ticketHistoryLength: student.ticketHistory ? student.ticketHistory.length : 0
                    };
                    
                    if (category === 'pbis') student.pbisTickets += amount;
                    else if (category === 'attendance') student.attendanceTickets += amount;
                    else if (category === 'academics') student.academicTickets += amount;
                    
                    // Add to student's history
                    if (!student.ticketHistory) student.ticketHistory = [];
                    student.ticketHistory.push({
                        timestamp: new Date().toISOString(),
                        category: categoryName,
                        subcategory: subcategory || null,
                        tickets: amount,
                        reason: reason || 'Perfect Attendance',
                        teacher: currentUser.name
                    });
                    
                    awardedStudents.push(previousState);
                    
                    // Log the action with subcategory and period info
                    const logReason = subcategory ? `${subcategory}: ${reason}` : (reason || 'Perfect Attendance');
                    
                    // Find which period/section this student belongs to for the current teacher
                    let periodInfo = null;
                    console.log('=== AWARD TICKETS DEBUG ===');
                    console.log('Looking up period for student:', student.id, student.firstName, student.lastName);
                    console.log('Current user sections:', currentUser.sections);
                    
                    if (currentUser.sections && currentUser.sections.length > 0) {
                        for (const section of currentUser.sections) {
                            console.log('Checking section:', section.period, section.courseName);
                            console.log('Section has students?', section.students?.length);
                            if (section.students) {
                                console.log('Section student IDs:', section.students.map(s => s.id));
                            }
                            
                            if (section.students && section.students.some(s => s.id === student.id)) {
                                periodInfo = {
                                    period: section.period,
                                    courseName: section.courseName
                                };
                                console.log('✅ FOUND period info:', periodInfo);
                                break;
                            }
                        }
                    } else {
                        console.log('❌ Current user has no sections!');
                    }
                    
                    if (!periodInfo) {
                        console.log('❌ Period info not found for this student');
                    }
                    
                    addToAuditLog('Awarded Tickets', studentId, categoryName, amount, logReason, periodInfo);
                }
            });

            // Update teacher's ticket count
            const teacher = teachers.find(t => t.id === currentUser.id);
            const previousTeacherTickets = teacher ? teacher.ticketsAwarded : 0;
            if (teacher) {
                teacher.ticketsAwarded += (amount * checkboxes.length);
            }

            // Store this award for UNDO
            lastAwardAction = {
                students: awardedStudents,
                category: category,
                amount: amount,
                teacherId: currentUser.id,
                teacherPreviousTickets: previousTeacherTickets,
                auditLogCount: auditLog.length // Track how many audit entries to remove
            };

            saveData();
            updateAllDisplays();
            updateDashboardStats(); // Update animated dashboard
            document.getElementById('selectAll').checked = false;
            document.getElementById('ticketReason').value = ''; // Clear reason field
            document.getElementById('subcategorySelect').value = ''; // Clear subcategory
            
            // Show UNDO button
            const undoButton = document.getElementById('undoAwardButton');
            if (undoButton) {
                undoButton.style.display = 'inline-block';
            }
            
            // Show success toast with animation
            showSuccessToast(`✅ Awarded ${amount} ticket(s) to ${checkboxes.length} student(s)!`);
            
            // Trigger confetti animation
            triggerConfetti();
            
            alert(`✅ Awarded ${amount} ticket(s) to ${checkboxes.length} student(s)!\n\nClick "UNDO" if this was a mistake.`);
        }
        
        // Show success toast notification
        function showSuccessToast(message) {
            const toast = document.createElement('div');
            toast.className = 'success-toast';
            toast.textContent = message;
            document.body.appendChild(toast);
            
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(400px)';
                setTimeout(() => toast.remove(), 500);
            }, 3000);
        }
        
        // Trigger confetti animation
        function triggerConfetti() {
            const colors = ['#667eea', '#764ba2', '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#ec4899'];
            const shapes = ['circle', 'square'];
            
            // Create 80 confetti pieces
            for (let i = 0; i < 80; i++) {
                setTimeout(() => {
                    const confetti = document.createElement('div');
                    const shape = shapes[Math.floor(Math.random() * shapes.length)];
                    const size = Math.random() * 15 + 10; // 10-25px
                    
                    confetti.style.position = 'fixed';
                    confetti.style.width = size + 'px';
                    confetti.style.height = size + 'px';
                    confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
                    confetti.style.left = Math.random() * 100 + '%';
                    confetti.style.top = '-50px';
                    confetti.style.borderRadius = shape === 'circle' ? '50%' : '0';
                    confetti.style.pointerEvents = 'none';
                    confetti.style.zIndex = '9999';
                    confetti.style.opacity = '0.9';
                    
                    // Random rotation and animation duration
                    const duration = Math.random() * 2 + 3; // 3-5 seconds
                    const rotation = Math.random() * 720 + 360; // 360-1080 degrees
                    const drift = Math.random() * 200 - 100; // -100 to 100px horizontal drift
                    
                    confetti.style.animation = `confetti-fall ${duration}s linear`;
                    confetti.style.setProperty('--drift', drift + 'px');
                    confetti.style.setProperty('--rotation', rotation + 'deg');
                    
                    document.body.appendChild(confetti);
                    
                    setTimeout(() => confetti.remove(), duration * 1000);
                }, i * 15); // Stagger the confetti
            }
        }

        // UNDO last ticket award
        async function undoLastAward() {
            if (!lastAwardAction) {
                alert('No recent award to undo!');
                return;
            }
            
            const confirm = window.confirm(
                `⚠️ UNDO Last Award\n\n` +
                `This will reverse the last ticket award for ${lastAwardAction.students.length} student(s).\n\n` +
                `Are you sure you want to undo?`
            );
            
            if (!confirm) return;
            
            // Restore each student's previous state
            lastAwardAction.students.forEach(prevState => {
                const student = students.find(s => s.id === prevState.studentId);
                if (student) {
                    // Restore ticket counts
                    student.pbisTickets = prevState.pbisTickets;
                    student.attendanceTickets = prevState.attendanceTickets;
                    student.academicTickets = prevState.academicTickets;
                    
                    // Remove the last history entry (the one we just added)
                    if (student.ticketHistory && student.ticketHistory.length > prevState.ticketHistoryLength) {
                        student.ticketHistory = student.ticketHistory.slice(0, prevState.ticketHistoryLength);
                    }
                }
            });
            
            // Restore teacher's ticket count
            const teacher = teachers.find(t => t.id === lastAwardAction.teacherId);
            if (teacher) {
                teacher.ticketsAwarded = lastAwardAction.teacherPreviousTickets;
            }
            
            // Remove audit log entries that were added
            const entriesToRemove = auditLog.length - lastAwardAction.auditLogCount;
            if (entriesToRemove > 0) {
                auditLog.splice(lastAwardAction.auditLogCount, entriesToRemove);
            }
            
            // Add a new audit log entry for the UNDO action
            const categoryName = lastAwardAction.category === 'pbis' ? 'PBIS' : 
                                lastAwardAction.category === 'attendance' ? 'Attendance' : 'Academics';
            
            const undoEntry = {
                timestamp: new Date().toISOString(),
                action: '↩️ UNDID Award',
                studentId: 'Multiple',
                studentName: `${lastAwardAction.students.length} student(s)`,
                category: categoryName,
                tickets: lastAwardAction.amount,
                reason: `Reversed ticket award for ${lastAwardAction.students.length} student(s)`,
                teacher: currentUser.name,
                teacherId: currentUser.id,
                period: null,
                courseName: null
            };
            
            auditLog.push(undoEntry);
            console.log('UNDO audit entry created:', undoEntry);
            console.log('Audit log now has', auditLog.length, 'entries');
            
            // Clear the undo action
            lastAwardAction = null;
            
            // Hide UNDO button
            const undoButton = document.getElementById('undoAwardButton');
            if (undoButton) {
                undoButton.style.display = 'none';
            }
            
            await saveData();
            updateAllDisplays();
            updateDashboardStats(); // Update animated dashboard
            
            alert('✅ Award successfully undone!');
        }

        function drawWinner() {
            const category = document.getElementById('raffleCategory').value;
            
            // Separate students by school
            const middleSchool = students.filter(s => s.grade >= 6 && s.grade <= 8);
            const highSchool = students.filter(s => s.grade >= 9 && s.grade <= 12);
            
            let msEligible = [];
            let hsEligible = [];

            // Filter by category for each school
            if (category === 'pbis') {
                msEligible = middleSchool.filter(s => s.pbisTickets > 0);
                hsEligible = highSchool.filter(s => s.pbisTickets > 0);
            } else if (category === 'attendance') {
                msEligible = middleSchool.filter(s => s.attendanceTickets > 0);
                hsEligible = highSchool.filter(s => s.attendanceTickets > 0);
            } else if (category === 'academics') {
                msEligible = middleSchool.filter(s => s.academicTickets > 0);
                hsEligible = highSchool.filter(s => s.academicTickets > 0);
            }

            if (msEligible.length === 0 && hsEligible.length === 0) {
                alert('No eligible students for this category in either school!');
                return;
            }

            const categoryName = category === 'pbis' ? 'PBIS Behaviors' : 
                                category === 'attendance' ? 'Perfect Attendance' : 'Academics';

            // Draw Middle School winner if eligible students exist
            if (msEligible.length > 0) {
                showRaffleSpinner(msEligible, 'Middle School', (msWinner) => {
                    weeklyWinners.push({
                        week: currentWeek,
                        category: categoryName,
                        school: 'Middle School',
                        student: msWinner,
                        date: new Date().toLocaleDateString()
                    });

                    addToAuditLog('Raffle Winner', msWinner.id, `${categoryName} - Middle School`, null, null);
                    
                    // Draw High School winner if eligible students exist
                    if (hsEligible.length > 0) {
                        setTimeout(() => {
                            showRaffleSpinner(hsEligible, 'High School', (hsWinner) => {
                                weeklyWinners.push({
                                    week: currentWeek,
                                    category: categoryName,
                                    school: 'High School',
                                    student: hsWinner,
                                    date: new Date().toLocaleDateString()
                                });

                                addToAuditLog('Raffle Winner', hsWinner.id, `${categoryName} - High School`, null, null);

                                saveData();
                                displayBothWinners(msWinner, hsWinner, categoryName);
                                updateWinnersList();
                                updateAllDisplays();
                                triggerConfetti();
                            });
                        }, 2000); // Delay between raffles
                    } else {
                        // Only MS winner
                        saveData();
                        displaySingleWinner(msWinner, categoryName, 'Middle School');
                        updateWinnersList();
                        updateAllDisplays();
                        triggerConfetti();
                    }
                });
            } else if (hsEligible.length > 0) {
                // Only HS has eligible students
                showRaffleSpinner(hsEligible, 'High School', (hsWinner) => {
                    weeklyWinners.push({
                        week: currentWeek,
                        category: categoryName,
                        school: 'High School',
                        student: hsWinner,
                        date: new Date().toLocaleDateString()
                    });

                    addToAuditLog('Raffle Winner', hsWinner.id, `${categoryName} - High School`, null, null);

                    saveData();
                    displaySingleWinner(hsWinner, categoryName, 'High School');
                    updateWinnersList();
                    updateAllDisplays();
                    triggerConfetti();
                });
            }
        }
        
        // Animated raffle spinner with school label
        function showRaffleSpinner(eligibleStudents, schoolName, callback) {
            const display = document.getElementById('winnerDisplay');
            
            // Create spinner overlay with school name
            display.innerHTML = `
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 50px; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.3); text-align: center;">
                    <div style="background: rgba(255,255,255,0.2); padding: 10px 20px; border-radius: 20px; display: inline-block; margin-bottom: 20px;">
                        <span style="color: white; font-weight: 600; font-size: 18px;">🏫 ${schoolName}</span>
                    </div>
                    <h2 style="color: white; margin-bottom: 30px; font-size: 32px;">🎰 Drawing Winner...</h2>
                    <div id="spinnerName" style="background: white; padding: 30px; border-radius: 12px; font-size: 36px; font-weight: 700; color: #667eea; min-height: 80px; display: flex; align-items: center; justify-content: center;">
                        ...
                    </div>
                </div>
            `;
            
            const spinnerName = document.getElementById('spinnerName');
            let spinCount = 0;
            const totalSpins = 30; // Number of name changes
            const initialDelay = 50; // Start fast
            
            function spin() {
                if (spinCount < totalSpins) {
                    // Show random student name
                    const randomStudent = eligibleStudents[Math.floor(Math.random() * eligibleStudents.length)];
                    spinnerName.textContent = `${randomStudent.firstName} ${randomStudent.lastName}`;
                    
                    // Gradually slow down
                    const delay = initialDelay + (spinCount * 8); // Gets slower
                    spinCount++;
                    
                    setTimeout(spin, delay);
                } else {
                    // Final winner
                    const winner = eligibleStudents[Math.floor(Math.random() * eligibleStudents.length)];
                    spinnerName.textContent = `${winner.firstName} ${winner.lastName}`;
                    spinnerName.style.animation = 'pulse 0.5s ease 3';
                    
                    setTimeout(() => callback(winner), 1500);
                }
            }
            
            spin();
        }

        function displayBothWinners(msWinner, hsWinner, category) {
            const display = document.getElementById('winnerDisplay');
            display.innerHTML = `
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                    <div class="winner-box animate-slide-in" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 30px; border-radius: 16px; box-shadow: 0 8px 30px rgba(245, 158, 11, 0.4); text-align: center;">
                        <div style="font-size: 48px; margin-bottom: 15px;">🎉</div>
                        <div style="background: rgba(255,255,255,0.2); padding: 8px 16px; border-radius: 20px; display: inline-block; margin-bottom: 15px;">
                            <span style="font-weight: 600;">🏫 Middle School</span>
                        </div>
                        <h3 style="color: white; font-size: 24px; margin: 0 0 10px 0;">🏆 WINNER!</h3>
                        <div style="background: white; color: #f59e0b; padding: 15px; border-radius: 12px; margin: 15px 0; font-size: 24px; font-weight: 700;">
                            ${msWinner.firstName} ${msWinner.lastName}
                        </div>
                        <p style="color: white; font-size: 14px; margin: 5px 0;">ID: ${msWinner.id}</p>
                        <p style="color: white; font-size: 14px; margin: 5px 0;">Grade: ${msWinner.grade}</p>
                        <p style="color: rgba(255,255,255,0.9); margin-top: 15px; font-size: 12px;">${category}</p>
                    </div>
                    <div class="winner-box animate-slide-in" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 30px; border-radius: 16px; box-shadow: 0 8px 30px rgba(16, 185, 129, 0.4); text-align: center; animation-delay: 0.2s;">
                        <div style="font-size: 48px; margin-bottom: 15px;">🎉</div>
                        <div style="background: rgba(255,255,255,0.2); padding: 8px 16px; border-radius: 20px; display: inline-block; margin-bottom: 15px;">
                            <span style="font-weight: 600;">🏫 High School</span>
                        </div>
                        <h3 style="color: white; font-size: 24px; margin: 0 0 10px 0;">🏆 WINNER!</h3>
                        <div style="background: white; color: #10b981; padding: 15px; border-radius: 12px; margin: 15px 0; font-size: 24px; font-weight: 700;">
                            ${hsWinner.firstName} ${hsWinner.lastName}
                        </div>
                        <p style="color: white; font-size: 14px; margin: 5px 0;">ID: ${hsWinner.id}</p>
                        <p style="color: white; font-size: 14px; margin: 5px 0;">Grade: ${hsWinner.grade}</p>
                        <p style="color: rgba(255,255,255,0.9); margin-top: 15px; font-size: 12px;">${category}</p>
                    </div>
                </div>
            `;
        }

        function displaySingleWinner(winner, category, school) {
            const display = document.getElementById('winnerDisplay');
            const schoolColor = school === 'Middle School' ? '#f59e0b' : '#10b981';
            const schoolColorDark = school === 'Middle School' ? '#d97706' : '#059669';
            
            display.innerHTML = `
                <div class="winner-box animate-slide-in" style="background: linear-gradient(135deg, ${schoolColor} 0%, ${schoolColorDark} 100%); color: white; padding: 40px; border-radius: 16px; box-shadow: 0 8px 30px rgba(16, 185, 129, 0.4); text-align: center;">
                    <div style="font-size: 64px; margin-bottom: 20px;">🎉</div>
                    <div style="background: rgba(255,255,255,0.2); padding: 10px 20px; border-radius: 20px; display: inline-block; margin-bottom: 20px;">
                        <span style="font-weight: 600; font-size: 18px;">🏫 ${school}</span>
                    </div>
                    <h2 style="color: white; font-size: 36px; margin: 0 0 15px 0;">🏆 WINNER! 🏆</h2>
                    <div style="background: white; color: ${schoolColor}; padding: 20px; border-radius: 12px; margin: 20px 0; font-size: 32px; font-weight: 700;">
                        ${winner.firstName} ${winner.lastName}
                    </div>
                    <p style="color: white; font-size: 18px; margin: 10px 0;">Student ID: ${winner.id}</p>
                    <p style="color: white; font-size: 18px; margin: 10px 0;">Grade: ${winner.grade}</p>
                    <p style="color: white; font-size: 18px; margin: 10px 0;">Category: ${category}</p>
                    <p style="color: rgba(255,255,255,0.9); margin-top: 20px; font-size: 14px;">Drawn on ${new Date().toLocaleDateString()}</p>
                </div>
            `;
        }

        function displayWinner(winner, category) {
            const display = document.getElementById('winnerDisplay');
            display.innerHTML = `
                <div class="winner-box animate-slide-in" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 40px; border-radius: 16px; box-shadow: 0 8px 30px rgba(16, 185, 129, 0.4); text-align: center;">
                    <div style="font-size: 64px; margin-bottom: 20px;">🎉</div>
                    <h2 style="color: white; font-size: 36px; margin: 0 0 15px 0;">🏆 WINNER! 🏆</h2>
                    <div style="background: white; color: #10b981; padding: 20px; border-radius: 12px; margin: 20px 0; font-size: 32px; font-weight: 700;">
                        ${winner.firstName} ${winner.lastName}
                    </div>
                    <p style="color: white; font-size: 18px; margin: 10px 0;">Student ID: ${winner.id}</p>
                    <p style="color: white; font-size: 18px; margin: 10px 0;">Category: ${category}</p>
                    <p style="color: rgba(255,255,255,0.9); margin-top: 20px; font-size: 14px;">Drawn on ${new Date().toLocaleDateString()}</p>
                </div>
            `;
        }

        function updateWinnersList() {
            const list = document.getElementById('winnersList');
            const thisWeekWinners = weeklyWinners.filter(w => w.week === currentWeek);
            
            if (thisWeekWinners.length === 0) {
                list.innerHTML = '<p style="color: #999;">No winners drawn yet</p>';
                return;
            }

            list.innerHTML = thisWeekWinners.map(w => {
                const schoolBadge = w.school ? `<span style="background: ${w.school === 'Middle School' ? '#f59e0b' : '#10b981'}; color: white; padding: 3px 8px; border-radius: 10px; font-size: 11px; margin-left: 5px;">${w.school}</span>` : '';
                return `
                    <div style="padding: 10px; background: #f7f7f7; border-radius: 6px; margin-bottom: 10px;">
                        <strong>${w.category}:</strong> ${w.student.firstName} ${w.student.lastName} (${w.student.id}) ${schoolBadge}
                        <span style="float: right; color: #666;">${w.date}</span>
                    </div>
                `;
            }).join('');
        }

        function drawBigRaffleWinner() {
            if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
                alert('Only admins can run the Wildcat Jackpot');
                return;
            }

            // Separate qualified students by school
            const msQualified = students.filter(s => s.bigRaffleQualified && s.grade >= 6 && s.grade <= 8);
            const hsQualified = students.filter(s => s.bigRaffleQualified && s.grade >= 9 && s.grade <= 12);
            
            if (msQualified.length === 0 && hsQualified.length === 0) {
                alert('No students qualified for the Wildcat Jackpot yet!');
                return;
            }

            const display = document.getElementById('bigWinnerDisplay');
            let winnersHtml = '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">';

            // Draw Middle School winner if qualified students exist
            if (msQualified.length > 0) {
                const msEntries = [];
                msQualified.forEach(student => {
                    const numEntries = student.weeksQualified || 1;
                    for (let i = 0; i < numEntries; i++) {
                        msEntries.push(student);
                    }
                });

                const msWinner = msEntries[Math.floor(Math.random() * msEntries.length)];
                
                bigRaffleWinners.push({
                    student: msWinner,
                    school: 'Middle School',
                    date: new Date().toLocaleDateString(),
                    cycle: Math.ceil(currentWeek / cycleDuration),
                    weeksQualified: msWinner.weeksQualified
                });

                addToAuditLog('Wildcat Jackpot Winner', msWinner.id, 'Grand Prize - Middle School', null, `Qualified for ${msWinner.weeksQualified} week(s)`);

                winnersHtml += `
                    <div class="winner-box" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 30px; border-radius: 16px; box-shadow: 0 8px 30px rgba(245, 158, 11, 0.4); text-align: center;">
                        <div style="font-size: 48px; margin-bottom: 15px;">🎊</div>
                        <div style="background: rgba(255,255,255,0.2); padding: 8px 16px; border-radius: 20px; display: inline-block; margin-bottom: 15px;">
                            <span style="font-weight: 600;">🏫 Middle School</span>
                        </div>
                        <h2 style="color: white; font-size: 28px; margin: 0 0 10px 0;">🏆 WILDCAT JACKPOT WINNER!</h2>
                        <div style="background: white; color: #f59e0b; padding: 15px; border-radius: 12px; margin: 15px 0; font-size: 24px; font-weight: 700;">
                            ${msWinner.firstName} ${msWinner.lastName}
                        </div>
                        <p style="color: white; font-size: 14px; margin: 5px 0;">ID: ${msWinner.id}</p>
                        <p style="color: white; font-size: 14px; margin: 5px 0;">Grade: ${msWinner.grade}</p>
                        <p style="color: white; font-size: 14px; margin: 10px 0;">Qualified for ${msWinner.weeksQualified} week(s)</p>
                        <p style="color: white; font-size: 12px; margin: 5px 0;">${msWinner.weeksQualified} ${msWinner.weeksQualified === 1 ? 'entry' : 'entries'} in drawing</p>
                        <p style="color: rgba(255,255,255,0.9); margin-top: 15px; font-size: 12px;">${new Date().toLocaleDateString()}</p>
                    </div>
                `;
            }

            // Draw High School winner if qualified students exist
            if (hsQualified.length > 0) {
                const hsEntries = [];
                hsQualified.forEach(student => {
                    const numEntries = student.weeksQualified || 1;
                    for (let i = 0; i < numEntries; i++) {
                        hsEntries.push(student);
                    }
                });

                const hsWinner = hsEntries[Math.floor(Math.random() * hsEntries.length)];
                
                bigRaffleWinners.push({
                    student: hsWinner,
                    school: 'High School',
                    date: new Date().toLocaleDateString(),
                    cycle: Math.ceil(currentWeek / cycleDuration),
                    weeksQualified: hsWinner.weeksQualified
                });

                addToAuditLog('Wildcat Jackpot Winner', hsWinner.id, 'Grand Prize - High School', null, `Qualified for ${hsWinner.weeksQualified} week(s)`);

                winnersHtml += `
                    <div class="winner-box" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 30px; border-radius: 16px; box-shadow: 0 8px 30px rgba(16, 185, 129, 0.4); text-align: center;">
                        <div style="font-size: 48px; margin-bottom: 15px;">🎊</div>
                        <div style="background: rgba(255,255,255,0.2); padding: 8px 16px; border-radius: 20px; display: inline-block; margin-bottom: 15px;">
                            <span style="font-weight: 600;">🏫 High School</span>
                        </div>
                        <h2 style="color: white; font-size: 28px; margin: 0 0 10px 0;">🏆 WILDCAT JACKPOT WINNER!</h2>
                        <div style="background: white; color: #10b981; padding: 15px; border-radius: 12px; margin: 15px 0; font-size: 24px; font-weight: 700;">
                            ${hsWinner.firstName} ${hsWinner.lastName}
                        </div>
                        <p style="color: white; font-size: 14px; margin: 5px 0;">ID: ${hsWinner.id}</p>
                        <p style="color: white; font-size: 14px; margin: 5px 0;">Grade: ${hsWinner.grade}</p>
                        <p style="color: white; font-size: 14px; margin: 10px 0;">Qualified for ${hsWinner.weeksQualified} week(s)</p>
                        <p style="color: white; font-size: 12px; margin: 5px 0;">${hsWinner.weeksQualified} ${hsWinner.weeksQualified === 1 ? 'entry' : 'entries'} in drawing</p>
                        <p style="color: rgba(255,255,255,0.9); margin-top: 15px; font-size: 12px;">${new Date().toLocaleDateString()}</p>
                    </div>
                `;
            }

            winnersHtml += '</div>';
            display.innerHTML = winnersHtml;

            saveData();
            triggerConfetti();
        }

        function nextWeek() {
            if (currentWeek >= cycleDuration) {
                if (confirm(`You've completed ${cycleDuration} weeks! Run the Wildcat Jackpot before starting a new cycle?`)) {
                    return;
                }
            }
            currentWeek++;
            saveData();
            updateAllDisplays();
        }

        function previousWeek() {
            if (currentWeek > 1) {
                currentWeek--;
                saveData();
                updateAllDisplays();
            }
        }

        // ========================================
        // AUTOMATIC WEEK DETECTION & RESET SYSTEM
        // ========================================
        
        function checkAndRunAutoWeekReset() {
            if (!autoWeekEnabled) {
                console.log('ℹ️ Auto-week system is disabled');
                return;
            }
            
            const now = new Date();
            const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
            const currentHour = now.getHours();
            
            // Check if it's the right day and time for reset
            const isResetDay = dayOfWeek === weekResetDay;
            const isPastResetTime = currentHour >= weekResetHour;
            
            if (!isResetDay || !isPastResetTime) {
                console.log(`ℹ️ Not time for auto-reset yet. Current: ${now.toLocaleString()}, Reset time: ${getDayName(weekResetDay)} ${weekResetHour}:00`);
                return;
            }
            
            // Check if we already reset this week
            if (lastAutoResetDate) {
                const lastReset = new Date(lastAutoResetDate);
                const daysSinceReset = Math.floor((now - lastReset) / (1000 * 60 * 60 * 24));
                
                // If last reset was less than 7 days ago, skip
                if (daysSinceReset < 7) {
                    console.log(`ℹ️ Already auto-reset this week on ${lastReset.toLocaleString()}`);
                    return;
                }
            }
            
            // Run automatic week reset
            console.log('🔄 Running automatic week reset...');
            performWeekReset(true); // true = automatic reset
        }
        
        function performWeekReset(isAutomatic = false) {
            // Calculate totals for this week before resetting
            const weekData = {
                week: currentWeek,
                pbisTickets: students.reduce((sum, s) => sum + (s.pbisTickets || 0), 0),
                attendanceTickets: students.reduce((sum, s) => sum + (s.attendanceTickets || 0), 0),
                academicTickets: students.reduce((sum, s) => sum + (s.academicTickets || 0), 0),
                studentsQualified: 0,
                date: new Date().toISOString(),
                resetType: isAutomatic ? 'automatic' : 'manual'
            };

            // Check which students should qualify for jackpot
            students.forEach(s => {
                // Student qualifies if they have tickets in ALL 3 categories
                if (s.pbisTickets > 0 && s.attendanceTickets > 0 && s.academicTickets > 0) {
                    if (!s.bigRaffleQualified) {
                        s.bigRaffleQualified = true;
                        addToAuditLog('Qualified for Wildcat Jackpot', s.id, null, null, `${isAutomatic ? 'Auto-qualified' : 'Qualified'} - tickets in all 3 categories`);
                    }
                    s.weeksQualified = (s.weeksQualified || 0) + 1;
                    weekData.studentsQualified++;
                }
                
                // Reset weekly ticket counts
                s.pbisTickets = 0;
                s.attendanceTickets = 0;
                s.academicTickets = 0;
            });

            // Add to history
            weeklyHistory.push(weekData);

            // Update last auto-reset date
            if (isAutomatic) {
                lastAutoResetDate = new Date().toISOString();
            }

            currentWeek++;
            saveData();
            updateAllDisplays();
            
            const message = `Week ${weekData.week} completed! ${weekData.studentsQualified} student(s) qualified for Wildcat Jackpot. Tickets reset.`;
            console.log(`✅ ${message}`);
            
            if (!isAutomatic) {
                alert(message);
            } else {
                // Show toast notification for automatic reset
                showSuccessToast(`🔄 Week auto-reset: ${weekData.studentsQualified} student(s) qualified for jackpot`);
            }
        }
        
        function getDayName(dayNumber) {
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            return days[dayNumber];
        }

        function completeWeek() {
            if (!confirm('⚠️ END OF WEEK PROCESS\n\nThis will:\n• Save this week\'s ticket data\n• Qualify eligible students for Wildcat Jackpot\n• Reset all ticket counts to 0\n• Move to next week\n\nOnly do this when the school week is over!\n\nContinue?')) return;

            performWeekReset(false); // false = manual reset
        }

        function resetBigRaffle() {
            if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
                alert('Only admins can reset the Wildcat Jackpot cycle');
                return;
            }

            if (!confirm(`This will reset the ${cycleDuration}-week cycle and clear all Wildcat Jackpot qualifications. Continue?`)) return;

            students.forEach(s => {
                s.bigRaffleQualified = false;
                s.weeksQualified = 0;
                s.pbisTickets = 0;
                s.attendanceTickets = 0;
                s.academicTickets = 0;
            });

            currentWeek = 1;
            weeklyWinners = [];
            weeklyHistory = []; // Clear history for new cycle
            
            addToAuditLog('Reset Wildcat Jackpot Cycle', null, null, null, null);
            
            saveData();
            updateAllDisplays();
            alert('Wildcat Jackpot cycle reset! Starting fresh from Week 1.');
        }

        function switchTab(tabName) {
            // Remove active class from all tabs and content
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            // Find and activate the tab button
            const tabButtons = document.querySelectorAll('.tab');
            tabButtons.forEach(tab => {
                if (tab.getAttribute('onclick') && tab.getAttribute('onclick').includes(`'${tabName}'`)) {
                    tab.classList.add('active');
                }
            });
            
            // Map friendly names to actual tab content IDs
            const tabIdMap = {
                'awardCash': 'awardCashTab',
                'cashActivity': 'cashActivityTab',
                'cashLeaderboard': 'cashLeaderboardTab',
                'rewardsStore': 'rewardsStoreTab',
                'studentAccounts': 'studentAccountsTab',
                'cashAnalytics': 'cashAnalyticsTab',
                'cashAudit': 'cashAuditTab'
            };
            
            // Get the actual content ID
            const contentId = tabIdMap[tabName] || tabName;
            
            // Activate the content using CSS class
            const content = document.getElementById(contentId);
            if (content) {
                content.classList.add('active');
            }
            
            // Populate settings when Settings tab is opened
            if (tabName === 'settings') {
                populateSettingsFields();
                loadBrandingSettings(); // Load branding form fields
                
                // Show/hide Cash Mode subtab based on current mode
                const cashSubtab = document.getElementById('cashSettingsSubtab');
                
                if (wildcatCashEnabled && currentUser && currentUser.role === 'superadmin') {
                    // Cash Mode: show cash settings subtab
                    if (cashSubtab) cashSubtab.style.display = '';
                    updateBehaviorsList();
                } else {
                    // Raffle Mode: hide cash settings subtab
                    if (cashSubtab) cashSubtab.style.display = 'none';
                }
                
                // Default to auto-week subtab
                switchSettingsSubtab('autoweek');
            }
            
            // Handle Raffle Mode data tab
            if (tabName === 'data') {
                updateAnalyticsCharts();
                updateAnalyticsTables();
            }
            
            // Handle Login Activity tab
            if (tabName === 'loginActivity' && currentUser && currentUser.role === 'superadmin') {
                updateLoginActivityTable();
            }
            
            // Handle Wildcat Cash tab-specific updates (data population)
            if (tabName === 'awardCash' && currentUser && currentUser.role === 'superadmin') {
                updateCashPeriodFilter();
                updateCashTable();
            } else if (tabName === 'cashActivity' && currentUser && currentUser.role === 'superadmin') {
                updateCashActivityLog();
            } else if (tabName === 'cashLeaderboard' && currentUser && currentUser.role === 'superadmin') {
                updateCashLeaderboards();
            } else if (tabName === 'rewardsStore' && currentUser && currentUser.role === 'superadmin') {
                updateRewardsStore();
            } else if (tabName === 'studentAccounts' && currentUser && currentUser.role === 'superadmin') {
                updateStudentAccounts();
            } else if (tabName === 'cashAnalytics' && currentUser && currentUser.role === 'superadmin') {
                updateCashAnalytics();
                // Initialize dashboard view
                switchAnalyticsSubtab('dashboard');
            } else if (tabName === 'cashAudit' && currentUser && currentUser.role === 'superadmin') {
                updateCashAuditLogTable();
            }
        }
        
        function populateSettingsFields() {
            // Populate Kickboard point values
            const pbisInput = document.getElementById('pbisKickboardPoints');
            const attendanceInput = document.getElementById('attendanceKickboardPoints');
            const academicInput = document.getElementById('academicKickboardPoints');
            
            if (pbisInput) pbisInput.value = kickboardSettings.pbisPoints;
            if (attendanceInput) attendanceInput.value = kickboardSettings.attendancePoints;
            if (academicInput) academicInput.value = kickboardSettings.academicPoints;
            
            // Populate EmailJS config
            const serviceIdInput = document.getElementById('emailJSServiceId');
            const templateIdInput = document.getElementById('emailJSTemplateId');
            const publicKeyInput = document.getElementById('emailJSPublicKey');
            
            if (serviceIdInput) serviceIdInput.value = emailJSConfig.serviceId || '';
            if (templateIdInput) templateIdInput.value = emailJSConfig.templateId || '';
            if (publicKeyInput) publicKeyInput.value = emailJSConfig.publicKey || '';
            
            // Populate Auto-Week settings
            const autoWeekToggle = document.getElementById('autoWeekToggle');
            const weekResetDaySelect = document.getElementById('weekResetDaySelect');
            const weekResetHourSelect = document.getElementById('weekResetHourSelect');
            
            if (autoWeekToggle) autoWeekToggle.checked = autoWeekEnabled;
            if (weekResetDaySelect) weekResetDaySelect.value = weekResetDay;
            if (weekResetHourSelect) weekResetHourSelect.value = weekResetHour;
            
            // Update displays
            updateAutoResetDisplay();
            
            // Populate Cycle configuration
            const cycleNameInput = document.getElementById('cycleNameInput');
            const cycleStartDate = document.getElementById('cycleStartDate');
            const cycleEndDate = document.getElementById('cycleEndDate');
            
            if (cycleNameInput) cycleNameInput.value = currentCycle.name || 'Cycle 1';
            if (cycleStartDate) cycleStartDate.value = currentCycle.startDate || '';
            if (cycleEndDate) cycleEndDate.value = currentCycle.endDate || '';
            
            updateCycleDisplay();
        }

        // Initialize
        (async function() {
            // Load data first so teachers array is populated
            await loadData();
            
            // Setup activity tracking for inactivity logout
            setupActivityListeners();
            
            // Check for existing session AFTER data is loaded
            const hasSession = loadSession();
            
            if (hasSession) {
                // User/student was logged in, restore their session
                if (currentUser) {
                    document.getElementById('loginScreen').classList.add('hidden');
                    document.getElementById('mainApp').classList.remove('hidden');
                    document.getElementById('currentUserName').textContent = currentUser.name;
                    document.getElementById('currentUserRole').textContent = getFriendlyRoleName(currentUser.role);
                    
                    // Show/hide tabs based on role
                    const adminTabs = document.querySelectorAll('.admin-only');
                    const superAdminTabs = document.querySelectorAll('.super-admin-only');
                    
                    if (currentUser.role === 'teacher' || currentUser.role === 'campusaide') {
                        adminTabs.forEach(tab => tab.classList.add('disabled'));
                        superAdminTabs.forEach(tab => tab.classList.add('disabled'));
                        
                        const weekControls = document.getElementById('weekControls');
                        if (weekControls) weekControls.style.display = 'none';
                        
                        // Force raffle mode for teachers and campus aides
                        wildcatCashEnabled = false;
                        disciplineModeEnabled = false;
                        localStorage.setItem('systemMode', 'raffle');
                        document.body.classList.remove('cash-mode', 'hallpass-mode', 'discipline-mode');
                        document.body.classList.add('raffle-mode');
                        const clawPassContent = document.getElementById('clawPassContent');
                        const disciplineContent = document.getElementById('disciplineContent');
                        if (clawPassContent) clawPassContent.style.display = 'none';
                        if (disciplineContent) disciplineContent.style.display = 'none';
                        
                        switchTab('tickets');
                    } else if (currentUser.role === 'admin') {
                        adminTabs.forEach(tab => tab.classList.remove('disabled'));
                        superAdminTabs.forEach(tab => tab.classList.add('disabled'));
                        
                        const weekControls = document.getElementById('weekControls');
                        if (weekControls) weekControls.style.display = 'flex';
                        
                        // Force raffle mode for admins
                        wildcatCashEnabled = false;
                        localStorage.setItem('systemMode', 'raffle');
                        document.body.classList.remove('cash-mode', 'hallpass-mode');
                        document.body.classList.add('raffle-mode');
                        const clawPassContent = document.getElementById('clawPassContent');
                        if (clawPassContent) clawPassContent.style.display = 'none';
                        
                        switchTab('students');
                    } else if (currentUser.role === 'superadmin') {
                        adminTabs.forEach(tab => tab.classList.remove('disabled'));
                        superAdminTabs.forEach(tab => tab.classList.remove('disabled'));
                        
                        const weekControls = document.getElementById('weekControls');
                        if (weekControls) weekControls.style.display = 'flex';
                        
                        // Restore system mode from localStorage
                        const savedMode = localStorage.getItem('systemMode');
                        if (savedMode === 'cash') {
                            wildcatCashEnabled = true;
                            // Set body class immediately
                            document.body.classList.add('cash-mode');
                            document.body.classList.remove('raffle-mode', 'hallpass-mode');
                            updateModeToggleUI();
                            updateTabVisibility();
                            // Will switch to awardCash tab via updateTabVisibility
                        } else if (savedMode === 'hallpass') {
                            wildcatCashEnabled = false;
                            document.body.classList.add('hallpass-mode');
                            document.body.classList.remove('raffle-mode', 'cash-mode', 'discipline-mode');
                            const clawPassContent = document.getElementById('clawPassContent');
                            const tabsContainer = document.querySelector('.tabs');
                            if (tabsContainer) tabsContainer.style.display = 'none';
                            if (clawPassContent) clawPassContent.style.display = 'block';
                            updateModeToggleUI();
                            switchHallPassTab('kiosk');
                        } else if (savedMode === 'discipline') {
                            wildcatCashEnabled = false;
                            disciplineModeEnabled = true;
                            document.body.classList.add('discipline-mode');
                            document.body.classList.remove('raffle-mode', 'cash-mode', 'hallpass-mode');
                            const disciplineContent = document.getElementById('disciplineContent');
                            const tabsContainer = document.querySelector('.tabs');
                            if (tabsContainer) tabsContainer.style.display = 'none';
                            if (disciplineContent) disciplineContent.style.display = 'block';
                            updateModeToggleUI();
                            switchDisciplineTab('submit');
                        } else {
                            // Set raffle mode body class
                            document.body.classList.add('raffle-mode');
                            document.body.classList.remove('cash-mode', 'hallpass-mode', 'discipline-mode');
                            updateModeToggleUI();
                            switchTab('students');
                        }
                    }
                    
                    // Update displays with fresh currentUser data
                    updateAllDisplays();
                    if (currentUser.role === 'superadmin' || currentUser.role === 'admin') {
                        updateSuperAdminList();
                    }
                } else if (currentStudent) {
                    document.getElementById('loginScreen').classList.add('hidden');
                    document.getElementById('studentApp').classList.remove('hidden');
                    updateStudentView();
                }
            } else {
                // No active session, show login screen
                // Hide create admin button if teachers already exist
                if (teachers.length > 0) {
                    const createAdminSection = document.getElementById('createAdminSection');
                    if (createAdminSection) {
                        createAdminSection.style.display = 'none';
                    }
                }
            }
            
            // Initialize Data & Analytics time filter to "All Time" by default
            setDataTimeFilter('allTime');
        })();

        // ========================================
        // WILDCAT CASH SYSTEM FUNCTIONS
        // ========================================

        // Mode Switching
        function switchSystemMode(mode) {
            if (currentUser.role !== 'superadmin' && currentUser.role !== 'admin') {
                alert('Only admins and superadmins can switch modes during beta testing.');
                return;
            }
            
            wildcatCashEnabled = (mode === 'cash');
            disciplineModeEnabled = (mode === 'discipline');
            const hallPassEnabled = (mode === 'hallpass');
            localStorage.setItem('systemMode', mode);
            
            // Add/remove body classes for CSS-based content hiding
            document.body.classList.remove('cash-mode', 'raffle-mode', 'hallpass-mode', 'discipline-mode');
            if (disciplineModeEnabled) {
                document.body.classList.add('discipline-mode');
            } else if (hallPassEnabled) {
                document.body.classList.add('hallpass-mode');
            } else if (wildcatCashEnabled) {
                document.body.classList.add('cash-mode');
            } else {
                document.body.classList.add('raffle-mode');
            }
            
            // Show/hide appropriate content
            const tabsContainer = document.querySelector('.tabs');
            const contentContainer = document.querySelector('.content');
            const clawPassContent = document.getElementById('clawPassContent');
            const disciplineContent = document.getElementById('disciplineContent');
            
            if (disciplineModeEnabled) {
                // Hide raffle/cash tabs and normal content, show Discipline Mode
                if (tabsContainer) tabsContainer.style.display = 'none';
                if (contentContainer) {
                    // Hide all tab-content divs inside content
                    contentContainer.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
                }
                if (clawPassContent) clawPassContent.style.display = 'none';
                if (disciplineContent) disciplineContent.style.display = 'block';
                switchDisciplineTab('submit'); // Default to submit view
            } else if (hallPassEnabled) {
                // Hide raffle/cash tabs and normal content, show Claw Pass
                if (tabsContainer) tabsContainer.style.display = 'none';
                if (contentContainer) {
                    // Hide all tab-content divs inside content
                    contentContainer.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
                }
                if (clawPassContent) clawPassContent.style.display = 'block';
                if (disciplineContent) disciplineContent.style.display = 'none';
                
                // IMPORTANT: Make sure subtab buttons are visible for admins/teachers
                // (openStudentKiosk hides them for students, but admins need them)
                document.querySelectorAll('.subtab-button').forEach(btn => {
                    btn.style.display = '';
                });
                
                switchHallPassTab('kiosk'); // Default to kiosk view
            } else {
                // Show raffle/cash tabs and content, hide Claw Pass and Discipline
                if (tabsContainer) tabsContainer.style.display = 'flex';
                if (contentContainer) {
                    // Remove inline display styles from tab-content divs to let CSS classes control visibility
                    contentContainer.querySelectorAll('.tab-content').forEach(el => el.style.display = '');
                }
                if (clawPassContent) clawPassContent.style.display = 'none';
                if (disciplineContent) disciplineContent.style.display = 'none';
                updateTabVisibility();
            }
            
            // Update UI
            updateModeToggleUI();
            
            console.log(`📊 Switched to ${mode} mode`);
        }

        function updateModeToggleUI() {
            const raffleModeBtn = document.getElementById('raffleModeBtn');
            const cashModeBtn = document.getElementById('cashModeBtn');
            const hallPassModeBtn = document.getElementById('hallPassModeBtn');
            const disciplineModeBtn = document.getElementById('disciplineModeBtn');
            const modeDescription = document.getElementById('modeDescription');
            
            const currentMode = localStorage.getItem('systemMode') || 'raffle';
            
            // Reset all buttons
            [raffleModeBtn, cashModeBtn, hallPassModeBtn, disciplineModeBtn].forEach(btn => {
                if (btn) {
                    btn.style.background = 'rgba(255,255,255,0.2)';
                    btn.style.color = 'white';
                    btn.style.border = '2px solid rgba(255,255,255,0.5)';
                }
            });
            
            // Highlight active mode
            if (currentMode === 'discipline') {
                disciplineModeBtn.style.background = '#FF6B35';
                disciplineModeBtn.style.border = '2px solid #FF6B35';
                modeDescription.textContent = 'Currently in Discipline Mode (Behavior Referrals)';
            } else if (currentMode === 'hallpass') {
                hallPassModeBtn.style.background = '#FF6B35';
                hallPassModeBtn.style.border = '2px solid #FF6B35';
                modeDescription.textContent = 'Currently in Claw Pass Mode (Hall Pass System)';
            } else if (currentMode === 'cash') {
                cashModeBtn.style.background = '#FF6B35';
                cashModeBtn.style.border = '2px solid #FF6B35';
                modeDescription.textContent = 'Currently in Wildcat Cash Mode';
            } else {
                raffleModeBtn.style.background = '#FF6B35';
                raffleModeBtn.style.border = '2px solid #FF6B35';
                modeDescription.textContent = 'Currently in Raffle Ticket Mode';
            }
        }

        function updateTabVisibility() {
            const tabsContainer = document.querySelector('.tabs');
            
            if (wildcatCashEnabled) {
                // Add cash tabs if not already added
                if (!document.getElementById('awardCashTabBtn')) {
                    const cashTabsHTML = `
                        <button class="tab active super-admin-only" id="awardCashTabBtn" onclick="switchTab('awardCash')">💰 Award Cash</button>
                        <button class="tab super-admin-only" id="cashActivityTabBtn" onclick="switchTab('cashActivity')">📝 My Activity</button>
                        <button class="tab super-admin-only" id="cashLeaderboardTabBtn" onclick="switchTab('cashLeaderboard')">🏆 Leaderboard</button>
                        <button class="tab super-admin-only" id="rewardsStoreTabBtn" onclick="switchTab('rewardsStore')">🏪 Rewards Store</button>
                        <button class="tab super-admin-only" id="studentAccountsTabBtn" onclick="switchTab('studentAccounts')">💳 Accounts</button>
                        <button class="tab super-admin-only" id="cashAnalyticsTabBtn" onclick="switchTab('cashAnalytics')">📊 Analytics</button>
                        <button class="tab super-admin-only" id="cashAuditTabBtn" onclick="switchTab('cashAudit')">📋 Audit Log</button>
                        <button class="tab super-admin-only" id="cashSettingsTabBtn" onclick="switchTab('settings')">⚙️ Settings</button>
                    `;
                    // Insert before system tab
                    const systemTab = document.getElementById('systemTab');
                    if (systemTab) {
                        systemTab.insertAdjacentHTML('beforebegin', cashTabsHTML);
                    }
                }
                // Switch to first cash tab
                switchTab('awardCash');
            } else {
                // Remove cash tab buttons
                const cashTabButtons = ['awardCashTabBtn', 'cashActivityTabBtn', 'cashLeaderboardTabBtn',
                                       'rewardsStoreTabBtn', 'studentAccountsTabBtn', 'cashAnalyticsTabBtn', 'cashAuditTabBtn', 'cashSettingsTabBtn'];
                cashTabButtons.forEach(btnId => {
                    const btn = document.getElementById(btnId);
                    if (btn) btn.remove();
                });
                // Switch to tickets tab
                switchTab('tickets');
            }
        }

        // Initialize student cash accounts
        function initializeStudentCashAccounts() {
            students.forEach(student => {
                if (student.wildcatCashBalance === undefined) {
                    student.wildcatCashBalance = STARTING_BALANCE;
                    student.wildcatCashEarned = 0;
                    student.wildcatCashSpent = 0;
                    student.wildcatCashDeducted = 0;
                    student.wildcatCashTransactions = [];
                    student.wildcatCashRewardsRedeemed = [];
                }
            });
        }

        // Award Cash
        function awardCashToSelected() {
            console.log('🎯 awardCashToSelected() called');
            
            const behaviorType = document.getElementById('cashBehaviorType').value;
            const behaviorId = document.getElementById('cashBehaviorSelect').value;
            const notes = document.getElementById('cashNotes').value.trim();
            
            console.log('Selected type:', behaviorType);
            console.log('Selected behavior ID:', behaviorId);
            
            if (!behaviorType) {
                alert('Please select a behavior type (Positive or Negative)');
                return;
            }
            
            if (!behaviorId) {
                alert('Please select a specific behavior');
                return;
            }
            
            const behavior = wildcatCashBehaviors.find(b => b.id === behaviorId);
            if (!behavior) {
                alert('Behavior not found');
                console.error('Behavior not found:', behaviorId);
                return;
            }
            
            console.log('Found behavior:', behavior);
            
            const checkboxes = document.querySelectorAll('#cashStudentTableBody input[type="checkbox"]:checked');
            console.log('Checked boxes:', checkboxes.length);
            
            if (checkboxes.length === 0) {
                alert('Please select at least one student');
                return;
            }
            
            const selectedStudents = Array.from(checkboxes).map(cb => cb.dataset.studentId);
            console.log('Selected student IDs:', selectedStudents);
            
            // Process each student
            let processed = 0;
            selectedStudents.forEach(studentId => {
                const student = students.find(s => s.id === studentId);
                if (!student) {
                    console.error('Student not found:', studentId);
                    return;
                }
                
                console.log('Processing student:', student.firstName, student.lastName);
                
                // Initialize if needed
                if (student.wildcatCashBalance === undefined) {
                    student.wildcatCashBalance = STARTING_BALANCE;
                    student.wildcatCashEarned = 0;
                    student.wildcatCashSpent = 0;
                    student.wildcatCashDeducted = 0;
                    student.wildcatCashTransactions = [];
                    student.wildcatCashRewardsRedeemed = [];
                }
                
                // Update balance
                const amount = behavior.points;
                const oldBalance = student.wildcatCashBalance;
                student.wildcatCashBalance += amount;
                
                console.log(`  ${student.firstName}: $${oldBalance} → $${student.wildcatCashBalance} (${amount > 0 ? '+' : ''}$${amount})`);
                
                if (amount > 0) {
                    student.wildcatCashEarned += amount;
                } else {
                    student.wildcatCashDeducted += Math.abs(amount);
                }
                
                // Create transaction
                const transaction = {
                    id: 'txn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                    timestamp: new Date().toISOString(),
                    studentId: student.id,
                    teacherId: currentUser.id,
                    teacherName: currentUser.name,
                    type: behavior.type,
                    behaviorId: behavior.id,
                    behaviorName: behavior.name,
                    amount: amount,
                    newBalance: student.wildcatCashBalance,
                    notes: notes || '',
                    period: student.sections && student.sections.length > 0 ? student.sections[0].period : 'N/A'
                };
                
                // Add to student's transactions
                if (!student.wildcatCashTransactions) {
                    student.wildcatCashTransactions = [];
                }
                student.wildcatCashTransactions.push(transaction);
                
                // Add to global transactions
                wildcatCashTransactions.push(transaction);
                
                // Add to audit log
                const logEntry = {
                    timestamp: new Date().toISOString(),
                    teacherId: currentUser.id,
                    teacherName: currentUser.name,
                    action: amount > 0 ? 'cash_award' : 'cash_deduct',
                    details: `${behavior.name}: $${amount} to ${student.firstName} ${student.lastName} (New balance: $${student.wildcatCashBalance})`,
                    studentId: student.id
                };
                auditLog.push(logEntry);
                
                processed++;
            });
            
            console.log(`✅ Processed ${processed} students`);
            
            // Save and update
            saveData();
            
            alert(`✅ Successfully awarded cash to ${selectedStudents.length} student(s)!`);
            
            // Clear form
            document.getElementById('cashBehaviorType').value = '';
            document.getElementById('cashBehaviorSelect').value = '';
            document.getElementById('cashBehaviorSelect').style.display = 'none';
            document.getElementById('cashAmount').value = '';
            document.getElementById('cashNotes').value = '';
            document.getElementById('cashSelectAll').checked = false;
            
            // Refresh table and displays
            updateCashTable();
            updateCashActivityLog();
            updateCashLeaderboards();
            updateCashAnalytics();
            
            console.log('🎉 Award cash completed successfully');
        }

        // Update Cash Table
        function updateCashTable() {
            const periodFilter = document.getElementById('cashPeriodFilter').value;
            const gradeFilter = document.getElementById('cashGradeFilter').value;
            const tbody = document.getElementById('cashStudentTableBody');
            const header = document.getElementById('cashClassHeader');
            const title = document.getElementById('cashClassTitle');
            const subtitle = document.getElementById('cashClassSubtitle');
            const count = document.getElementById('cashStudentCount');
            
            // Filter students
            let filteredStudents = students;
            
            // Apply grade filter
            if (gradeFilter) {
                filteredStudents = filteredStudents.filter(student => student.grade === gradeFilter);
            }
            
            // Apply period filter
            if (currentUser.role === 'teacher' && periodFilter) {
                filteredStudents = filteredStudents.filter(student => 
                    student.sections && student.sections.some(s => s.period === periodFilter)
                );
            } else if (currentUser.role === 'teacher') {
                filteredStudents = filteredStudents.filter(student => 
                    student.sections && student.sections.some(s => 
                        currentUser.sections && currentUser.sections.some(ts => ts.period === s.period)
                    )
                );
            } else if (periodFilter && currentUser.role !== 'teacher') {
                filteredStudents = filteredStudents.filter(student =>
                    student.sections && student.sections.some(s => s.period === periodFilter)
                );
            }
            
            // Sort by name
            filteredStudents.sort((a, b) => {
                const nameA = `${a.lastName}, ${a.firstName}`.toLowerCase();
                const nameB = `${b.lastName}, ${b.firstName}`.toLowerCase();
                return nameA.localeCompare(nameB);
            });
            
            // Update header
            if (filteredStudents.length > 0) {
                header.style.display = 'block';
                let titleText = '';
                let subtitleText = '';
                
                if (gradeFilter && periodFilter) {
                    const periodInfo = filteredStudents[0].sections?.find(s => s.period === periodFilter);
                    titleText = `Grade ${gradeFilter} - Period ${periodFilter}${periodInfo ? ' - ' + periodInfo.className : ''}`;
                    subtitleText = `${filteredStudents.length} students`;
                } else if (gradeFilter) {
                    titleText = `Grade ${gradeFilter}`;
                    subtitleText = `${filteredStudents.length} students in this grade`;
                } else if (periodFilter) {
                    const periodInfo = filteredStudents[0].sections?.find(s => s.period === periodFilter);
                    titleText = `Period ${periodFilter}${periodInfo ? ' - ' + periodInfo.className : ''}`;
                    subtitleText = `${filteredStudents.length} students in this class`;
                } else {
                    titleText = 'All Students';
                    subtitleText = `${filteredStudents.length} students total`;
                }
                
                title.textContent = titleText;
                subtitle.textContent = subtitleText;
                count.textContent = filteredStudents.length;
            } else {
                header.style.display = 'none';
            }
            
            // Build table
            tbody.innerHTML = '';
            
            if (filteredStudents.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: #999;">No students to display</td></tr>';
                return;
            }
            
            filteredStudents.forEach(student => {
                // Initialize if needed
                if (student.wildcatCashBalance === undefined) {
                    student.wildcatCashBalance = STARTING_BALANCE;
                    student.wildcatCashEarned = 0;
                    student.wildcatCashSpent = 0;
                    student.wildcatCashDeducted = 0;
                }
                
                const balanceColor = student.wildcatCashBalance >= 0 ? '#10b981' : '#ef4444';
                const balanceStyle = `background: ${balanceColor}; color: white; padding: 6px 12px; border-radius: 20px; font-weight: 700; display: inline-block; min-width: 60px; text-align: center;`;
                
                const row = document.createElement('tr');
                row.style.background = tbody.children.length % 2 === 0 ? '#f9f9f9' : 'white';
                row.style.transition = 'all 0.2s';
                row.onmouseover = () => { row.style.background = '#e8f4ff'; row.style.transform = 'scale(1.01)'; };
                row.onmouseout = () => { row.style.background = tbody.children.length % 2 === 0 ? '#f9f9f9' : 'white'; row.style.transform = 'scale(1)'; };
                
                row.innerHTML = `
                    <td style="text-align: center;">
                        <input type="checkbox" data-student-id="${student.id}" style="width: 18px; height: 18px; cursor: pointer;">
                    </td>
                    <td style="color: #666; font-size: 14px;">${student.id}</td>
                    <td style="font-weight: 600; color: #333; font-size: 14px;">${student.lastName}, ${student.firstName}</td>
                    <td style="text-align: center;"><span style="${balanceStyle}">$${student.wildcatCashBalance}</span></td>
                    <td style="text-align: center;"><span style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 700; display: inline-block; min-width: 60px;">$${student.wildcatCashEarned}</span></td>
                    <td style="text-align: center;"><span style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 6px 12px; border-radius: 20px; font-weight: 700; display: inline-block; min-width: 60px;">$${student.wildcatCashSpent}</span></td>
                `;
                
                tbody.appendChild(row);
            });
        }

        // Toggle select all
        function toggleCashSelectAll() {
            const selectAll = document.getElementById('cashSelectAll');
            const checkboxes = document.querySelectorAll('#cashStudentTableBody input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = selectAll.checked);
        }

        // Update behavior options
        function updateCashBehaviorOptions() {
            const typeSelect = document.getElementById('cashBehaviorType');
            const behaviorSelect = document.getElementById('cashBehaviorSelect');
            const amountInput = document.getElementById('cashAmount');
            
            const selectedType = typeSelect.value;
            
            if (!selectedType) {
                behaviorSelect.style.display = 'none';
                amountInput.value = '';
                return;
            }
            
            // Show behavior select
            behaviorSelect.style.display = 'block';
            
            // Filter behaviors by type
            const filteredBehaviors = wildcatCashBehaviors.filter(b => b.type === selectedType && b.active !== false);
            
            // Populate select
            behaviorSelect.innerHTML = '<option value="">Select behavior...</option>';
            filteredBehaviors.forEach(behavior => {
                const option = document.createElement('option');
                option.value = behavior.id;
                option.textContent = `${behavior.name} (${behavior.points > 0 ? '+' : ''}$${behavior.points})`;
                behaviorSelect.appendChild(option);
            });
            
            // Listen for behavior selection
            behaviorSelect.onchange = () => {
                const behaviorId = behaviorSelect.value;
                if (behaviorId) {
                    const behavior = wildcatCashBehaviors.find(b => b.id === behaviorId);
                    if (behavior) {
                        amountInput.value = behavior.points;
                    }
                } else {
                    amountInput.value = '';
                }
            };
        }

        // Update cash period filter
        function updateCashPeriodFilter() {
            const select = document.getElementById('cashPeriodFilter');
            select.innerHTML = '<option value="">All Students</option>';
            
            if (currentUser.role === 'teacher' && currentUser.sections) {
                const periodOrder = ['A1', 'P1', 'P2', 'P3', 'P4', 'HPU', 'P5', 'P6', 'A2'];
                const sortedSections = [...currentUser.sections].sort((a, b) => {
                    const indexA = periodOrder.indexOf(a.period);
                    const indexB = periodOrder.indexOf(b.period);
                    if (indexA === -1) return 1;
                    if (indexB === -1) return -1;
                    return indexA - indexB;
                });
                
                sortedSections.forEach(section => {
                    const option = document.createElement('option');
                    option.value = section.period;
                    option.textContent = `Period ${section.period} - ${section.className}`;
                    select.appendChild(option);
                });
            }
        }

        // Update Cash Activity Log
        function updateCashActivityLog() {
            const container = document.getElementById('cashActivityLog');
            
            // Get teacher's transactions - check teacherId, addedBy, or removedBy
            const teacherTransactions = wildcatCashTransactions.filter(t => {
                const teacherId = t.teacherId || t.addedBy || t.removedBy;
                // Match by ID or username (since Add/Remove use username)
                return teacherId === currentUser.id || teacherId === currentUser.username;
            });
            
            // Sort by timestamp (newest first)
            teacherTransactions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            if (teacherTransactions.length === 0) {
                container.innerHTML = '<p style="text-align: center; color: #999; padding: 40px;">No transactions yet</p>';
                return;
            }
            
            container.innerHTML = '';
            
            teacherTransactions.forEach(txn => {
                const student = students.find(s => s.id === txn.studentId);
                const studentName = student ? `${student.firstName} ${student.lastName}` : 'Unknown Student';
                const date = new Date(txn.timestamp).toLocaleString();
                const amountClass = txn.amount > 0 ? 'positive' : 'negative';
                const amountColor = txn.amount > 0 ? '#10b981' : '#ef4444';
                
                const card = document.createElement('div');
                card.style.cssText = 'background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 15px;';
                card.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: 15px;">
                        <div style="flex: 1;">
                            <div style="font-weight: 600; color: #333; margin-bottom: 5px;">${studentName}</div>
                            <div style="color: #666; font-size: 14px; margin-bottom: 5px;">${txn.behaviorName}</div>
                            <div style="color: #999; font-size: 13px;">${date}</div>
                            ${txn.notes ? `<div style="color: #666; font-size: 13px; margin-top: 10px; font-style: italic;">Note: ${txn.notes}</div>` : ''}
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 24px; font-weight: 700; color: ${amountColor};">${txn.amount > 0 ? '+' : ''}$${txn.amount}</div>
                            <div style="color: #666; font-size: 13px; margin-top: 5px;">New balance: $${txn.newBalance}</div>
                        </div>
                    </div>
                `;
                container.appendChild(card);
            });
        }

        // Update Cash Leaderboards
        function updateCashLeaderboards() {
            // Top Earners
            const topEarners = [...students]
                .filter(s => s.wildcatCashEarned > 0)
                .sort((a, b) => b.wildcatCashEarned - a.wildcatCashEarned)
                .slice(0, 10);
            
            const topEarnersBoard = document.getElementById('topEarnersBoard');
            topEarnersBoard.innerHTML = '';
            
            if (topEarners.length === 0) {
                topEarnersBoard.innerHTML = '<p style="color: rgba(255,255,255,0.8); text-align: center;">No data yet</p>';
            } else {
                topEarners.forEach((student, index) => {
                    const rank = index + 1;
                    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
                    const div = document.createElement('div');
                    div.style.cssText = 'background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;';
                    div.innerHTML = `
                        <span style="color: white; font-weight: 600;">${medal} ${student.firstName} ${student.lastName}</span>
                        <span style="color: white; font-weight: 700;">$${student.wildcatCashEarned}</span>
                    `;
                    topEarnersBoard.appendChild(div);
                });
            }
            
            // Top Spenders
            const topSpenders = [...students]
                .filter(s => s.wildcatCashSpent > 0)
                .sort((a, b) => b.wildcatCashSpent - a.wildcatCashSpent)
                .slice(0, 10);
            
            const topSpendersBoard = document.getElementById('topSpendersBoard');
            topSpendersBoard.innerHTML = '';
            
            if (topSpenders.length === 0) {
                topSpendersBoard.innerHTML = '<p style="color: rgba(255,255,255,0.8); text-align: center;">No data yet</p>';
            } else {
                topSpenders.forEach((student, index) => {
                    const rank = index + 1;
                    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
                    const div = document.createElement('div');
                    div.style.cssText = 'background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;';
                    div.innerHTML = `
                        <span style="color: white; font-weight: 600;">${medal} ${student.firstName} ${student.lastName}</span>
                        <span style="color: white; font-weight: 700;">$${student.wildcatCashSpent}</span>
                    `;
                    topSpendersBoard.appendChild(div);
                });
            }
            
            // Richest Students
            const richest = [...students]
                .sort((a, b) => (b.wildcatCashBalance || STARTING_BALANCE) - (a.wildcatCashBalance || STARTING_BALANCE))
                .slice(0, 10);
            
            const richestBoard = document.getElementById('richestStudentsBoard');
            richestBoard.innerHTML = '';
            
            richest.forEach((student, index) => {
                const rank = index + 1;
                const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
                const balance = student.wildcatCashBalance !== undefined ? student.wildcatCashBalance : STARTING_BALANCE;
                const div = document.createElement('div');
                div.style.cssText = 'background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;';
                div.innerHTML = `
                    <span style="color: white; font-weight: 600;">${medal} ${student.firstName} ${student.lastName}</span>
                    <span style="color: white; font-weight: 700;">$${balance}</span>
                `;
                richestBoard.appendChild(div);
            });
        }

        // Update Rewards Store
        function updateRewardsStore() {
            const container = document.getElementById('rewardsList');
            container.innerHTML = '';
            
            const availableRewards = wildcatCashRewards.filter(r => r.available !== false);
            
            if (availableRewards.length === 0) {
                container.innerHTML = '<p style="text-align: center; color: #999; padding: 40px; grid-column: 1/-1;">No rewards available</p>';
                return;
            }
            
            availableRewards.forEach(reward => {
                const card = document.createElement('div');
                card.style.cssText = 'background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);';
                card.innerHTML = `
                    <h3 style="margin: 0 0 10px 0; color: #333;">${reward.name}</h3>
                    <div style="font-size: 24px; font-weight: 700; color: #667eea; margin-bottom: 15px;">$${reward.cost}</div>
                    <button class="btn" onclick="openRedeemRewardModal('${reward.id}')" style="width: 100%;">🎁 Redeem for Student</button>
                `;
                container.appendChild(card);
            });
            
            // Update redemption history
            updateRedemptionHistory();
        }

        function updateRedemptionHistory() {
            const container = document.getElementById('redemptionHistory');
            
            // Get recent redemptions
            const redemptions = [];
            students.forEach(student => {
                if (student.wildcatCashRewardsRedeemed && student.wildcatCashRewardsRedeemed.length > 0) {
                    student.wildcatCashRewardsRedeemed.forEach(redemption => {
                        redemptions.push({
                            ...redemption,
                            studentName: `${student.firstName} ${student.lastName}`
                        });
                    });
                }
            });
            
            // Sort by timestamp
            redemptions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            if (redemptions.length === 0) {
                container.innerHTML = '<p style="text-align: center; color: #999; padding: 20px;">No redemptions yet</p>';
                return;
            }
            
            container.innerHTML = '';
            redemptions.slice(0, 20).forEach(redemption => {
                const date = new Date(redemption.timestamp).toLocaleString();
                const card = document.createElement('div');
                card.style.cssText = 'background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;';
                card.innerHTML = `
                    <div>
                        <div style="font-weight: 600; color: #333;">${redemption.studentName}</div>
                        <div style="color: #666; font-size: 14px;">${redemption.rewardName}</div>
                        <div style="color: #999; font-size: 13px;">${date}</div>
                    </div>
                    <div style="font-size: 20px; font-weight: 700; color: #f5576c;">-$${redemption.cost}</div>
                `;
                container.appendChild(card);
            });
        }

        // Update Student Accounts
        function updateStudentAccounts() {
            const container = document.getElementById('studentAccountsGrid');
            const searchTerm = document.getElementById('accountSearch').value.toLowerCase();
            
            // Get selected grade from dropdown
            const selectedGrade = document.getElementById('accountGradeFilter').value;
            
            let filteredStudents = students.filter(student => {
                const fullName = `${student.firstName} ${student.lastName}`.toLowerCase();
                const id = student.id.toLowerCase();
                const matchesSearch = fullName.includes(searchTerm) || id.includes(searchTerm);
                const matchesGrade = selectedGrade === 'all' || student.grade == selectedGrade;
                return matchesSearch && matchesGrade;
            });
            
            // Sort by name
            filteredStudents.sort((a, b) => {
                const nameA = `${a.lastName}, ${a.firstName}`.toLowerCase();
                const nameB = `${b.lastName}, ${b.firstName}`.toLowerCase();
                return nameA.localeCompare(nameB);
            });
            
            container.innerHTML = '';
            
            if (filteredStudents.length === 0) {
                container.innerHTML = '<p style="text-align: center; color: #999; padding: 40px; grid-column: 1/-1;">No students found</p>';
                return;
            }
            
            filteredStudents.forEach(student => {
                // Initialize if needed
                if (student.wildcatCashBalance === undefined) {
                    student.wildcatCashBalance = STARTING_BALANCE;
                    student.wildcatCashEarned = 0;
                    student.wildcatCashSpent = 0;
                    student.wildcatCashDeducted = 0;
                    student.wildcatCashTransactions = [];
                }
                
                const balanceColor = student.wildcatCashBalance >= 0 ? '#10b981' : '#ef4444';
                
                const card = document.createElement('div');
                card.style.cssText = 'background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);';
                
                // Recent transactions
                const recentTxns = (student.wildcatCashTransactions || [])
                    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                    .slice(0, 5);
                
                let txnsHTML = '';
                if (recentTxns.length > 0) {
                    txnsHTML = '<div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #e0e0e0;"><div style="font-weight: 600; color: #666; font-size: 13px; margin-bottom: 10px;">Recent Transactions</div>';
                    recentTxns.forEach(txn => {
                        const txnColor = txn.amount > 0 ? '#10b981' : '#ef4444';
                        txnsHTML += `
                            <div style="display: flex; justify-content: space-between; padding: 8px 0; font-size: 13px;">
                                <span style="color: #666;">${txn.behaviorName}</span>
                                <span style="color: ${txnColor}; font-weight: 600;">${txn.amount > 0 ? '+' : ''}$${txn.amount}</span>
                            </div>
                        `;
                    });
                    txnsHTML += '</div>';
                }
                
                card.innerHTML = `
                    <div style="text-align: center; margin-bottom: 20px;">
                        <h3 style="margin: 0 0 5px 0; color: #333;">${student.firstName} ${student.lastName}</h3>
                        <div style="color: #999; font-size: 14px;">ID: ${student.id} | Grade: ${student.grade}</div>
                    </div>
                    
                    <div style="text-align: center; margin-bottom: 20px;">
                        <div style="font-size: 36px; font-weight: 700; color: ${balanceColor};">$${student.wildcatCashBalance}</div>
                        <div style="color: #999; font-size: 13px;">Current Balance</div>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; text-align: center; margin-bottom: 15px;">
                        <div>
                            <div style="font-size: 18px; font-weight: 600; color: #10b981;">$${student.wildcatCashEarned}</div>
                            <div style="color: #999; font-size: 12px;">Earned</div>
                        </div>
                        <div>
                            <div style="font-size: 18px; font-weight: 600; color: #f093fb;">$${student.wildcatCashSpent}</div>
                            <div style="color: #999; font-size: 12px;">Spent</div>
                        </div>
                        <div>
                            <div style="font-size: 18px; font-weight: 600; color: #ef4444;">$${student.wildcatCashDeducted}</div>
                            <div style="color: #999; font-size: 12px;">Deducted</div>
                        </div>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px;">
                        <button onclick="showAddCashModal('${student.id}')" style="background: #10b981; color: white; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 14px; transition: all 0.3s;">
                            ➕ Add Cash
                        </button>
                        <button onclick="showRemoveCashModal('${student.id}')" style="background: #ef4444; color: white; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 14px; transition: all 0.3s;">
                            ➖ Remove Cash
                        </button>
                    </div>
                    
                    ${txnsHTML}
                `;
                
                container.appendChild(card);
            });
        }

        function filterStudentAccounts() {
            updateStudentAccounts();
        }

        // Update Cash Analytics
        function updateCashAnalytics() {
            // This function is called when switching to the Analytics tab
            // The dashboard is now updated via updateDashboard() which is called
            // when the subtab is initialized
            
            // Keep the behavior frequency analysis for the cashAnalyticsDetails section
            const container = document.getElementById('cashAnalyticsDetails');
            if (!container) return;
            
            // Behavior frequency
            const behaviorFreq = {};
            wildcatCashTransactions.forEach(txn => {
                if (!behaviorFreq[txn.behaviorName]) {
                    behaviorFreq[txn.behaviorName] = { count: 0, total: 0 };
                }
                behaviorFreq[txn.behaviorName].count++;
                behaviorFreq[txn.behaviorName].total += txn.amount;
            });
            
            const sortedBehaviors = Object.entries(behaviorFreq)
                .sort((a, b) => b[1].count - a[1].count)
                .slice(0, 10);
            
            let behaviorHTML = '<div style="background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-top: 30px;"><h3>Most Common Behaviors (All Time)</h3>';
            
            if (sortedBehaviors.length === 0) {
                behaviorHTML += '<p style="color: #666; text-align: center; padding: 20px;">No behavior data yet.</p>';
            } else {
                sortedBehaviors.forEach(([name, data]) => {
                    const color = data.total > 0 ? '#10b981' : '#ef4444';
                    behaviorHTML += `
                        <div style="display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e0e0e0;">
                            <span style="color: #333; font-weight: 600;">${name}</span>
                            <span style="color: ${color};">${data.count} times (${data.total > 0 ? '+' : ''}$${data.total})</span>
                        </div>
                    `;
                });
            }
            behaviorHTML += '</div>';
            
            container.innerHTML = behaviorHTML;
        }

        // Behavior Management
        function showAddBehaviorModal() {
            document.getElementById('addBehaviorModal').classList.remove('hidden');
        }

        function closeAddBehaviorModal() {
            document.getElementById('addBehaviorModal').classList.add('hidden');
            document.getElementById('newBehaviorName').value = '';
            document.getElementById('newBehaviorType').value = 'positive';
            document.getElementById('newBehaviorPoints').value = '10';
        }

        function addNewBehavior() {
            const name = document.getElementById('newBehaviorName').value.trim();
            const type = document.getElementById('newBehaviorType').value;
            const points = parseInt(document.getElementById('newBehaviorPoints').value);
            
            if (!name) {
                alert('Please enter a behavior name');
                return;
            }
            
            if (isNaN(points) || points === 0) {
                alert('Please enter a valid point value (cannot be zero)');
                return;
            }
            
            // Create new behavior
            const behavior = {
                id: 'wc_custom_' + Date.now(),
                name: name,
                points: type === 'negative' ? -Math.abs(points) : Math.abs(points),
                type: type,
                active: true,
                custom: true
            };
            
            wildcatCashBehaviors.push(behavior);
            saveData();
            
            closeAddBehaviorModal();
            updateBehaviorsList();
            alert('✅ Behavior added successfully!');
        }

        function updateBehaviorsList() {
            const container = document.getElementById('behaviorsList');
            container.innerHTML = '';
            
            // Group by type
            const positive = wildcatCashBehaviors.filter(b => b.type === 'positive');
            const negative = wildcatCashBehaviors.filter(b => b.type === 'negative');
            
            const renderBehaviors = (behaviors, title, color) => {
                const section = document.createElement('div');
                section.style.cssText = 'margin-bottom: 20px;';
                section.innerHTML = `<h4 style="color: ${color}; margin-bottom: 10px;">${title}</h4>`;
                
                behaviors.forEach(behavior => {
                    const div = document.createElement('div');
                    div.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 10px; background: #f9f9f9; border-radius: 6px; margin-bottom: 8px;';
                    div.innerHTML = `
                        <div>
                            <span style="font-weight: 600;">${behavior.name}</span>
                            <span style="color: ${color}; margin-left: 10px;">${behavior.points > 0 ? '+' : ''}$${behavior.points}</span>
                        </div>
                        <div>
                            ${behavior.custom ? `<button class="btn-secondary" onclick="deleteBehavior('${behavior.id}')" style="padding: 6px 12px; font-size: 13px;">🗑️ Delete</button>` : ''}
                        </div>
                    `;
                    section.appendChild(div);
                });
                
                container.appendChild(section);
            };
            
            renderBehaviors(positive, '✅ Positive Behaviors', '#10b981');
            renderBehaviors(negative, '❌ Negative Behaviors', '#ef4444');
        }

        function deleteBehavior(behaviorId) {
            if (!confirm('Are you sure you want to delete this behavior?')) return;
            
            const index = wildcatCashBehaviors.findIndex(b => b.id === behaviorId);
            if (index !== -1) {
                wildcatCashBehaviors.splice(index, 1);
                saveData();
                updateBehaviorsList();
                alert('Behavior deleted successfully');
            }
        }

        // Reward Management
        function showAddRewardModal() {
            document.getElementById('addRewardModal').classList.remove('hidden');
        }

        function closeAddRewardModal() {
            document.getElementById('addRewardModal').classList.add('hidden');
            document.getElementById('newRewardName').value = '';
            document.getElementById('newRewardCost').value = '50';
        }

        function addNewReward() {
            const name = document.getElementById('newRewardName').value.trim();
            const cost = parseInt(document.getElementById('newRewardCost').value);
            
            if (!name) {
                alert('Please enter a reward name');
                return;
            }
            
            if (isNaN(cost) || cost <= 0) {
                alert('Please enter a valid cost (must be positive)');
                return;
            }
            
            const reward = {
                id: 'reward_custom_' + Date.now(),
                name: name,
                cost: cost,
                available: true,
                custom: true
            };
            
            wildcatCashRewards.push(reward);
            saveData();
            
            closeAddRewardModal();
            updateRewardsStore();
            alert('✅ Reward added successfully!');
        }

        function openRedeemRewardModal(rewardId) {
            const reward = wildcatCashRewards.find(r => r.id === rewardId);
            if (!reward) return;
            
            // Store reward ID for later
            window.currentRedeemRewardId = rewardId;
            
            // Populate student select
            const select = document.getElementById('redeemStudentSelect');
            select.innerHTML = '<option value="">Select a student...</option>';
            
            // Sort students by name
            const sortedStudents = [...students].sort((a, b) => {
                const nameA = `${a.lastName}, ${a.firstName}`.toLowerCase();
                const nameB = `${b.lastName}, ${b.firstName}`.toLowerCase();
                return nameA.localeCompare(nameB);
            });
            
            sortedStudents.forEach(student => {
                const balance = student.wildcatCashBalance !== undefined ? student.wildcatCashBalance : STARTING_BALANCE;
                const canAfford = balance >= reward.cost;
                const option = document.createElement('option');
                option.value = student.id;
                option.textContent = `${student.firstName} ${student.lastName} (Balance: $${balance})`;
                option.disabled = !canAfford;
                if (!canAfford) {
                    option.textContent += ' - Insufficient funds';
                }
                select.appendChild(option);
            });
            
            // Show reward info
            document.getElementById('redeemRewardInfo').innerHTML = `
                <div style="background: #f0f9ff; padding: 15px; border-radius: 8px; border-left: 4px solid #667eea;">
                    <div style="font-weight: 600; color: #333; margin-bottom: 5px;">${reward.name}</div>
                    <div style="font-size: 20px; font-weight: 700; color: #667eea;">Cost: $${reward.cost}</div>
                </div>
            `;
            
            document.getElementById('redeemRewardModal').classList.remove('hidden');
        }

        function closeRedeemRewardModal() {
            document.getElementById('redeemRewardModal').classList.add('hidden');
            window.currentRedeemRewardId = null;
        }

        function confirmRedeemReward() {
            const studentId = document.getElementById('redeemStudentSelect').value;
            const rewardId = window.currentRedeemRewardId;
            
            if (!studentId) {
                alert('Please select a student');
                return;
            }
            
            const student = students.find(s => s.id === studentId);
            const reward = wildcatCashRewards.find(r => r.id === rewardId);
            
            if (!student || !reward) {
                alert('Error: Student or reward not found');
                return;
            }
            
            // Initialize if needed
            if (student.wildcatCashBalance === undefined) {
                student.wildcatCashBalance = STARTING_BALANCE;
                student.wildcatCashEarned = 0;
                student.wildcatCashSpent = 0;
                student.wildcatCashDeducted = 0;
                student.wildcatCashTransactions = [];
                student.wildcatCashRewardsRedeemed = [];
            }
            
            // Check balance
            if (student.wildcatCashBalance < reward.cost) {
                alert('Student has insufficient funds for this reward');
                return;
            }
            
            // Process redemption
            student.wildcatCashBalance -= reward.cost;
            student.wildcatCashSpent += reward.cost;
            
            // Create transaction
            const transaction = {
                id: 'txn_reward_' + Date.now(),
                timestamp: new Date().toISOString(),
                studentId: student.id,
                teacherId: currentUser.id,
                teacherName: currentUser.name,
                type: 'reward',
                behaviorId: rewardId,
                behaviorName: reward.name,
                amount: -reward.cost,
                newBalance: student.wildcatCashBalance,
                notes: `Redeemed: ${reward.name}`,
                period: 'N/A'
            };
            
            student.wildcatCashTransactions.push(transaction);
            wildcatCashTransactions.push(transaction);
            
            // Add to redemption history
            const redemption = {
                rewardId: reward.id,
                rewardName: reward.name,
                cost: reward.cost,
                timestamp: new Date().toISOString(),
                redeemedBy: currentUser.name
            };
            
            if (!student.wildcatCashRewardsRedeemed) {
                student.wildcatCashRewardsRedeemed = [];
            }
            student.wildcatCashRewardsRedeemed.push(redemption);
            
            // Add to audit log
            const logEntry = {
                timestamp: new Date().toISOString(),
                teacherId: currentUser.id,
                teacherName: currentUser.name,
                action: 'reward_redemption',
                details: `${student.firstName} ${student.lastName} redeemed ${reward.name} for $${reward.cost} (New balance: $${student.wildcatCashBalance})`,
                studentId: student.id
            };
            auditLog.push(logEntry);
            
            saveData();
            
            alert(`✅ Successfully redeemed ${reward.name} for ${student.firstName} ${student.lastName}!`);
            closeRedeemRewardModal();
            updateRewardsStore();
            updateStudentAccounts();
        }

        function saveCashSettings() {
            STARTING_BALANCE = parseInt(document.getElementById('startingBalance').value) || 250;
            // Save other settings as needed
            saveData();
            alert('✅ Settings saved successfully!');
        }

        function resetAllStudentCash() {
            const confirmation = prompt('⚠️ WARNING: This will reset ALL student Wildcat Cash balances to $0.\n\nType "RESET ALL CASH" to confirm:');
            
            if (confirmation !== 'RESET ALL CASH') {
                if (confirmation !== null) {
                    alert('❌ Reset cancelled. You must type "RESET ALL CASH" exactly to confirm.');
                }
                return;
            }
            
            let resetCount = 0;
            
            // Reset all student cash balances
            students.forEach(student => {
                if (student.wildcatCashBalance !== undefined) {
                    student.wildcatCashBalance = 0;
                    student.wildcatCashSpent = 0;
                    resetCount++;
                    
                    // Add transaction record
                    const transaction = {
                        id: 'txn_reset_' + Date.now() + '_' + student.id,
                        timestamp: new Date().toISOString(),
                        studentId: student.id,
                        teacherId: currentUser.id,
                        teacherName: currentUser.name,
                        type: 'system_reset',
                        behaviorId: 'system_reset',
                        behaviorName: 'System Reset to $0',
                        amount: -student.wildcatCashBalance,
                        newBalance: 0,
                        notes: 'All student accounts reset by administrator',
                        period: 'N/A'
                    };
                    
                    if (!student.wildcatCashTransactions) {
                        student.wildcatCashTransactions = [];
                    }
                    student.wildcatCashTransactions.push(transaction);
                    wildcatCashTransactions.push(transaction);
                }
            });
            
            // Add to audit log
            const logEntry = {
                timestamp: new Date().toISOString(),
                teacherId: currentUser.id,
                teacherName: currentUser.name,
                action: 'reset_all_student_cash',
                details: `Reset all ${resetCount} student Wildcat Cash accounts to $0`,
                studentId: 'all'
            };
            auditLog.push(logEntry);
            
            saveData();
            
            alert(`✅ Successfully reset ${resetCount} student cash accounts to $0!`);
            
            // Refresh displays if on relevant tabs
            if (document.getElementById('studentAccountsTab').classList.contains('active')) {
                updateStudentAccounts();
            }
        }

        // Analytics Subtab Functions
        function switchAnalyticsSubtab(subtab) {
            // Update button styles
            document.querySelectorAll('.analytics-subtab').forEach(btn => {
                btn.style.background = '#f5f5f5';
                btn.style.color = '#333';
            });
            
            // Hide all subtab contents
            document.querySelectorAll('.analytics-subtab-content').forEach(content => {
                content.style.display = 'none';
            });
            
            // Show selected subtab
            if (subtab === 'dashboard') {
                document.getElementById('dashboardSubtab').style.background = '#FF6B35';
                document.getElementById('dashboardSubtab').style.color = 'white';
                document.getElementById('analyticsDashboard').style.display = 'block';
                updateDashboard();
            } else if (subtab === 'teacherInteractions') {
                document.getElementById('teacherInteractionsSubtab').style.background = '#FF6B35';
                document.getElementById('teacherInteractionsSubtab').style.color = 'white';
                document.getElementById('analyticsTeacherInteractions').style.display = 'block';
                updateTeacherInteractions();
            } else if (subtab === 'transactions') {
                document.getElementById('transactionsSubtab').style.background = '#FF6B35';
                document.getElementById('transactionsSubtab').style.color = 'white';
                document.getElementById('analyticsTransactions').style.display = 'block';
            } else if (subtab === 'trends') {
                document.getElementById('trendsSubtab').style.background = '#FF6B35';
                document.getElementById('trendsSubtab').style.color = 'white';
                document.getElementById('analyticsTrends').style.display = 'block';
            }
        }

        function updateDashboard() {
            // Get selected grades
            const selectedGrades = Array.from(document.querySelectorAll('.grade-filter-checkbox:checked'))
                .map(cb => cb.value);
            
            if (selectedGrades.length === 0) {
                // No grades selected - show zeros
                document.getElementById('avgBehaviorsPerStudent').textContent = '0.0';
                document.getElementById('avgPositivityRatio').textContent = '0%';
                document.getElementById('avgDollarsPerStudent').textContent = '$0';
                document.getElementById('dashTotalStudents').textContent = '0';
                document.getElementById('dashTotalPositive').textContent = '0';
                document.getElementById('dashTotalNegative').textContent = '0';
                document.getElementById('dashTotalAwarded').textContent = '$0';
                document.getElementById('dashTotalDeducted').textContent = '$0';
                document.getElementById('dashTotalCirculation').textContent = '$0';
                return;
            }
            
            // Filter students by selected grades
            const filteredStudents = students.filter(s => selectedGrades.includes(String(s.grade)));
            
            if (filteredStudents.length === 0) {
                // No students in selected grades
                document.getElementById('avgBehaviorsPerStudent').textContent = '0.0';
                document.getElementById('avgPositivityRatio').textContent = '0%';
                document.getElementById('avgDollarsPerStudent').textContent = '$0';
                document.getElementById('dashTotalStudents').textContent = '0';
                document.getElementById('dashTotalPositive').textContent = '0';
                document.getElementById('dashTotalNegative').textContent = '0';
                document.getElementById('dashTotalAwarded').textContent = '$0';
                document.getElementById('dashTotalDeducted').textContent = '$0';
                document.getElementById('dashTotalCirculation').textContent = '$0';
                return;
            }
            
            // Calculate metrics
            let totalPositiveBehaviors = 0;
            let totalNegativeBehaviors = 0;
            let totalBalance = 0;
            let totalAwarded = 0;
            let totalDeducted = 0;
            
            filteredStudents.forEach(student => {
                if (!student.wildcatCashTransactions) return;
                
                student.wildcatCashTransactions.forEach(txn => {
                    // Check for positive or negative type (behavior transactions)
                    if (txn.type === 'positive' || txn.type === 'negative') {
                        if (txn.amount > 0) {
                            totalPositiveBehaviors++;
                            totalAwarded += txn.amount;
                        } else if (txn.amount < 0) {
                            totalNegativeBehaviors++;
                            totalDeducted += Math.abs(txn.amount);
                        }
                    }
                });
                
                totalBalance += (student.wildcatCashBalance || 0);
            });
            
            const totalBehaviors = totalPositiveBehaviors + totalNegativeBehaviors;
            
            // Calculate averages
            const avgBehaviors = totalBehaviors / filteredStudents.length;
            const positivityRatio = totalBehaviors > 0 ? (totalPositiveBehaviors / totalBehaviors * 100) : 0;
            const avgBalance = totalBalance / filteredStudents.length;
            
            // Update dashboard
            document.getElementById('avgBehaviorsPerStudent').textContent = avgBehaviors.toFixed(1);
            document.getElementById('avgPositivityRatio').textContent = positivityRatio.toFixed(1) + '%';
            document.getElementById('avgDollarsPerStudent').textContent = '$' + Math.round(avgBalance).toLocaleString();
            
            document.getElementById('dashTotalStudents').textContent = filteredStudents.length;
            document.getElementById('dashTotalPositive').textContent = totalPositiveBehaviors;
            document.getElementById('dashTotalNegative').textContent = totalNegativeBehaviors;
            document.getElementById('dashTotalAwarded').textContent = '$' + Math.round(totalAwarded).toLocaleString();
            document.getElementById('dashTotalDeducted').textContent = '$' + Math.round(totalDeducted).toLocaleString();
            document.getElementById('dashTotalCirculation').textContent = '$' + Math.round(totalBalance).toLocaleString();
        }

        // ========================================
        // TEACHER INTERACTIONS ANALYTICS
        // ========================================

        function updateTeacherInteractions() {
            console.log('Updating Teacher Interactions analytics...');
            
            // Analyze teacher activity from wildcatCashTransactions
            const teacherStats = {};
            
            // Initialize stats for all teachers
            teachers.forEach(teacher => {
                teacherStats[teacher.id] = {
                    name: teacher.name,
                    totalInteractions: 0,
                    positiveCount: 0,
                    negativeCount: 0,
                    totalAwarded: 0,
                    totalDeducted: 0,
                    studentsImpacted: new Set()
                };
            });
            
            // Aggregate data from all student transactions
            students.forEach(student => {
                if (student.wildcatCashTransactions && student.wildcatCashTransactions.length > 0) {
                    student.wildcatCashTransactions.forEach(txn => {
                        // Check for teacherId field (from Award Cash) OR addedBy/removedBy (from Add/Remove Cash)
                        const teacherId = txn.teacherId || txn.addedBy || txn.removedBy;
                        
                        // Find teacher by ID or username (Add/Remove Cash uses username)
                        let matchedTeacher = null;
                        for (const teacher of teachers) {
                            if (teacher.id === teacherId || teacher.username === teacherId) {
                                matchedTeacher = teacher;
                                break;
                            }
                        }
                        
                        if (!matchedTeacher || !teacherStats[matchedTeacher.id]) return;
                        
                        const stats = teacherStats[matchedTeacher.id];
                        stats.totalInteractions++;
                        stats.studentsImpacted.add(student.id);
                        
                        if (txn.type === 'positive') {
                            stats.positiveCount++;
                            stats.totalAwarded += Math.abs(txn.amount);
                        } else if (txn.type === 'negative') {
                            stats.negativeCount++;
                            stats.totalDeducted += Math.abs(txn.amount);
                        }
                    });
                }
            });
            
            // Calculate summary stats
            let totalPositive = 0;
            let totalNegative = 0;
            let activeTeacherCount = 0;
            
            Object.values(teacherStats).forEach(stats => {
                if (stats.totalInteractions > 0) {
                    activeTeacherCount++;
                    totalPositive += stats.positiveCount;
                    totalNegative += stats.negativeCount;
                }
            });
            
            const overallPositivityRatio = (totalPositive + totalNegative) > 0 
                ? (totalPositive / (totalPositive + totalNegative) * 100) 
                : 0;
            
            // Update summary cards
            document.getElementById('teacherInteractionsActiveCount').textContent = activeTeacherCount;
            document.getElementById('teacherInteractionsTotalPositive').textContent = totalPositive.toLocaleString();
            document.getElementById('teacherInteractionsTotalNegative').textContent = totalNegative.toLocaleString();
            document.getElementById('teacherInteractionsPositivityRatio').textContent = overallPositivityRatio.toFixed(1) + '%';
            
            // Update teacher activity table
            updateTeacherActivityTable(teacherStats);
            
            // Update intervention students table
            updateInterventionStudents();
            
            // Update detailed interactions table
            updateTeacherInteractionDetails();
            
            // Populate teacher filter dropdown
            populateTeacherFilterDropdown();
        }

        function updateTeacherActivityTable(teacherStats) {
            const tbody = document.getElementById('teacherActivityTableBody');
            
            // Convert to array and sort by total interactions (descending)
            const sortedTeachers = Object.values(teacherStats)
                .filter(stats => stats.totalInteractions > 0)
                .sort((a, b) => b.totalInteractions - a.totalInteractions);
            
            if (sortedTeachers.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px; color: #999;">No teacher activity recorded yet</td></tr>';
                return;
            }
            
            tbody.innerHTML = sortedTeachers.map(stats => {
                const positivityRatio = stats.totalInteractions > 0 
                    ? (stats.positiveCount / stats.totalInteractions * 100) 
                    : 0;
                
                const positivityColor = positivityRatio >= 70 ? '#10b981' : 
                                       positivityRatio >= 50 ? '#f59e0b' : '#ef4444';
                
                return `
                    <tr>
                        <td style="font-weight: 600;">${stats.name}</td>
                        <td style="text-align: center; font-weight: 600;">${stats.totalInteractions}</td>
                        <td style="text-align: center; color: #10b981; font-weight: 600;">${stats.positiveCount}</td>
                        <td style="text-align: center; color: #ef4444; font-weight: 600;">${stats.negativeCount}</td>
                        <td style="text-align: center; color: ${positivityColor}; font-weight: 700; font-size: 16px;">
                            ${positivityRatio.toFixed(1)}%
                        </td>
                        <td style="text-align: center; color: #10b981;">$${stats.totalAwarded.toLocaleString()}</td>
                        <td style="text-align: center; color: #ef4444;">$${stats.totalDeducted.toLocaleString()}</td>
                        <td style="text-align: center;">${stats.studentsImpacted.size}</td>
                    </tr>
                `;
            }).join('');
        }

        function updateInterventionStudents() {
            const tbody = document.getElementById('interventionStudentsTableBody');
            
            // Identify students needing intervention
            // Criteria: 5+ negative behaviors OR balance < $1000 OR total deducted > $2000
            const flaggedStudents = students.filter(student => {
                if (!student.wildcatCashTransactions) return false;
                
                const negativeCount = student.wildcatCashTransactions.filter(t => t.type === 'negative').length;
                const balance = student.wildcatCashBalance || 0;
                const totalDeducted = student.wildcatCashDeducted || 0;
                
                return negativeCount >= 5 || balance < 1000 || totalDeducted > 2000;
            }).sort((a, b) => {
                // Sort by most concerning (lowest balance or most deductions)
                const aScore = (a.wildcatCashBalance || 0) - (a.wildcatCashDeducted || 0);
                const bScore = (b.wildcatCashBalance || 0) - (b.wildcatCashDeducted || 0);
                return aScore - bScore;
            });
            
            if (flaggedStudents.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: #10b981; font-weight: 600;">✅ No students currently flagged for intervention</td></tr>';
                return;
            }
            
            tbody.innerHTML = flaggedStudents.map(student => {
                const negativeCount = student.wildcatCashTransactions.filter(t => t.type === 'negative').length;
                const balance = student.wildcatCashBalance || 0;
                const totalDeducted = student.wildcatCashDeducted || 0;
                
                // Find teachers who have interacted with this student
                const teachersSet = new Set();
                student.wildcatCashTransactions.forEach(txn => {
                    const teacherId = txn.teacherId || txn.addedBy || txn.removedBy;
                    // Match by ID or username
                    const teacher = teachers.find(t => t.id === teacherId || t.username === teacherId);
                    if (teacher) teachersSet.add(teacher.name);
                });
                const primaryTeachers = Array.from(teachersSet).slice(0, 3).join(', ');
                
                const balanceColor = balance < 500 ? '#ef4444' : balance < 1500 ? '#f59e0b' : '#10b981';
                
                return `
                    <tr style="background: ${balance < 500 ? 'rgba(239, 68, 68, 0.05)' : 'white'};">
                        <td style="font-weight: 600;">${student.firstName} ${student.lastName}</td>
                        <td style="text-align: center;">${student.grade}</td>
                        <td style="text-align: center; color: ${balanceColor}; font-weight: 700; font-size: 16px;">
                            $${balance.toLocaleString()}
                        </td>
                        <td style="text-align: center; color: #ef4444; font-weight: 600;">$${totalDeducted.toLocaleString()}</td>
                        <td style="text-align: center; color: #ef4444; font-weight: 700; font-size: 16px;">
                            ${negativeCount}
                        </td>
                        <td style="font-size: 13px;">${primaryTeachers || 'None'}</td>
                        <td style="text-align: center;">
                            <button class="btn btn-secondary" onclick="viewStudentCashDetails('${student.id}')" style="padding: 6px 12px; font-size: 12px;">
                                View Details
                            </button>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function updateTeacherInteractionDetails() {
            const tbody = document.getElementById('teacherInteractionDetailsTableBody');
            
            // Get filter values
            const selectedTeacher = document.getElementById('teacherInteractionFilterTeacher').value;
            const selectedType = document.getElementById('teacherInteractionFilterType').value;
            const searchText = document.getElementById('teacherInteractionFilterStudent').value.toLowerCase();
            
            // Collect all transactions
            const allTransactions = [];
            students.forEach(student => {
                if (student.wildcatCashTransactions) {
                    student.wildcatCashTransactions.forEach(txn => {
                        allTransactions.push({
                            ...txn,
                            studentId: student.id,
                            studentName: `${student.firstName} ${student.lastName}`,
                            grade: student.grade
                        });
                    });
                }
            });
            
            console.log('=== TEACHER INTERACTIONS DEBUG ===');
            console.log('Total transactions:', allTransactions.length);
            console.log('Sample transaction:', allTransactions[0]);
            console.log('Teachers array:', teachers);
            console.log('Current user:', currentUser);
            
            // Filter transactions
            let filteredTransactions = allTransactions.filter(txn => {
                // Filter by teacher - check teacherId, addedBy, or removedBy
                const teacherId = txn.teacherId || txn.addedBy || txn.removedBy;
                if (selectedTeacher) {
                    // Match by ID directly, or find teacher by username and compare IDs
                    const teacher = teachers.find(t => t.id === selectedTeacher);
                    const matches = teacherId === selectedTeacher || 
                                  (teacher && teacher.username === teacherId);
                    if (!matches) return false;
                }
                
                // Filter by type
                if (selectedType === 'positive' && txn.type !== 'positive') return false;
                if (selectedType === 'negative' && txn.type !== 'negative') return false;
                
                // Filter by student name
                if (searchText && !txn.studentName.toLowerCase().includes(searchText)) return false;
                
                return true;
            });
            
            // Sort by timestamp (most recent first)
            filteredTransactions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            // Limit to 100 most recent
            filteredTransactions = filteredTransactions.slice(0, 100);
            
            if (filteredTransactions.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px; color: #999;">No interactions match the current filters</td></tr>';
                return;
            }
            
            tbody.innerHTML = filteredTransactions.map(txn => {
                // Get teacher name - prefer stored teacherName, fallback to looking up by ID or username
                let teacherName = txn.teacherName;
                if (!teacherName) {
                    const teacherId = txn.teacherId || txn.addedBy || txn.removedBy;
                    // Try to find teacher by ID or username (Add/Remove Cash uses username)
                    const teacher = teachers.find(t => t.id === teacherId || t.username === teacherId);
                    teacherName = teacher ? teacher.name : `Unknown (${teacherId})`;
                }
                
                const date = new Date(txn.timestamp);
                const formattedDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
                
                const typeColor = txn.type === 'positive' ? '#10b981' : '#ef4444';
                const typeBadge = txn.type === 'positive' ? 'Positive' : 'Negative';
                const amountDisplay = txn.type === 'positive' ? `+$${Math.abs(txn.amount)}` : `-$${Math.abs(txn.amount)}`;
                
                return `
                    <tr>
                        <td style="font-size: 13px; color: #666;">${formattedDate}</td>
                        <td>${teacherName}</td>
                        <td style="font-weight: 600;">${txn.studentName}</td>
                        <td style="text-align: center;">${txn.grade}</td>
                        <td>${txn.behaviorName || '-'}</td>
                        <td style="text-align: center;">
                            <span style="padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; background: ${typeColor}; color: white;">
                                ${typeBadge}
                            </span>
                        </td>
                        <td style="text-align: center; color: ${typeColor}; font-weight: 700; font-size: 16px;">
                            ${amountDisplay}
                        </td>
                        <td style="font-size: 13px;">${txn.notes || '-'}</td>
                    </tr>
                `;
            }).join('');
        }

        function populateTeacherFilterDropdown() {
            const dropdown = document.getElementById('teacherInteractionFilterTeacher');
            
            // Get unique teachers who have made transactions
            const activeTeachers = new Set();
            students.forEach(student => {
                if (student.wildcatCashTransactions) {
                    student.wildcatCashTransactions.forEach(txn => {
                        const teacherId = txn.teacherId || txn.addedBy || txn.removedBy;
                        if (!teacherId) return;
                        
                        // Find the teacher by ID or username and add their ID to the set
                        const teacher = teachers.find(t => t.id === teacherId || t.username === teacherId);
                        if (teacher) activeTeachers.add(teacher.id);
                    });
                }
            });
            
            // Build dropdown options
            const options = ['<option value="">All Teachers</option>'];
            teachers.forEach(teacher => {
                if (activeTeachers.has(teacher.id)) {
                    options.push(`<option value="${teacher.id}">${teacher.name}</option>`);
                }
            });
            
            dropdown.innerHTML = options.join('');
        }

        function viewStudentCashDetails(studentId) {
            // Switch to Student Accounts tab and focus on this student
            switchTab('studentAccounts');
            
            // Scroll to and highlight the student's row
            setTimeout(() => {
                const rows = document.querySelectorAll('#studentAccountsTableBody tr');
                rows.forEach(row => {
                    if (row.dataset.studentId === studentId) {
                        row.style.background = 'rgba(102, 126, 234, 0.1)';
                        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        setTimeout(() => {
                            row.style.background = '';
                        }, 3000);
                    }
                });
            }, 100);
        }

        // ========================================
        // DISCIPLINE MODE FUNCTIONS
        // ========================================

        function switchDisciplineTab(subtab) {
            // Hide all subtabs
            document.querySelectorAll('.discipline-subtab').forEach(tab => tab.classList.add('hidden'));
            
            // Reset all button styles
            document.querySelectorAll('.subtab-button').forEach(btn => {
                btn.style.background = '#f5f5f5';
                btn.style.color = '#333';
            });
            
            // Show selected subtab and highlight button
            if (subtab === 'submit') {
                document.getElementById('behaviorSubmit').classList.remove('hidden');
                const btn = document.getElementById('submitTabBtn');
                btn.style.background = '#f59e0b';
                btn.style.color = 'white';
                populateReferralStudentDropdown();
            } else if (subtab === 'review') {
                document.getElementById('behaviorReview').classList.remove('hidden');
                const btn = document.getElementById('reviewTabBtn');
                btn.style.background = '#f59e0b';
                btn.style.color = 'white';
                updateReferralReviewTable();
            } else if (subtab === 'detention') {
                document.getElementById('behaviorDetention').classList.remove('hidden');
                const btn = document.getElementById('detentionTabBtn');
                btn.style.background = '#f59e0b';
                btn.style.color = 'white';
                initializeDetentionForm();
                updateDetentionLists();
            } else if (subtab === 'history') {
                document.getElementById('behaviorHistory').classList.remove('hidden');
                const btn = document.getElementById('historyDisciplineTabBtn');
                btn.style.background = '#f59e0b';
                btn.style.color = 'white';
                populateHistoryStudentDropdown();
            } else if (subtab === 'analytics') {
                document.getElementById('behaviorAnalytics').classList.remove('hidden');
                const btn = document.getElementById('analyticsDisciplineTabBtn');
                btn.style.background = '#f59e0b';
                btn.style.color = 'white';
                updateReferralAnalytics();
            }
        }

        function populateReferralStudentDropdown() {
            const select = document.getElementById('referralStudentSelect');
            const sortedStudents = [...students].sort((a, b) => {
                const aName = `${a.lastName}, ${a.firstName}`.toLowerCase();
                const bName = `${b.lastName}, ${b.firstName}`.toLowerCase();
                return aName.localeCompare(bName);
            });
            
            select.innerHTML = '<option value="">Select a student...</option>' + 
                sortedStudents.map(s => 
                    `<option value="${s.id}">${s.lastName}, ${s.firstName} (Grade ${s.grade})</option>`
                ).join('');
        }

        function populateHistoryStudentDropdown() {
            const select = document.getElementById('historyStudentSelect');
            const sortedStudents = [...students].sort((a, b) => {
                const aName = `${a.lastName}, ${a.firstName}`.toLowerCase();
                const bName = `${b.lastName}, ${b.firstName}`.toLowerCase();
                return aName.localeCompare(bName);
            });
            
            select.innerHTML = '<option value="">Select a student...</option>' + 
                sortedStudents.map(s => 
                    `<option value="${s.id}">${s.lastName}, ${s.firstName} (Grade ${s.grade})</option>`
                ).join('');
        }

        function selectSeverity(severity, element) {
            // Remove selected styling from all severity options
            document.querySelectorAll('input[name="referralSeverity"]').forEach(radio => {
                radio.parentElement.style.borderColor = '#e0e0e0';
                radio.parentElement.style.background = 'white';
            });
            
            // Add selected styling
            element.style.borderColor = severity === 'Minor' ? '#10b981' : severity === 'Major' ? '#f59e0b' : '#dc3545';
            element.style.background = severity === 'Minor' ? 'rgba(16, 185, 129, 0.05)' : severity === 'Major' ? 'rgba(245, 158, 11, 0.05)' : 'rgba(220, 53, 69, 0.05)';
        }

        async function submitBehaviorReferral() {
            const studentId = document.getElementById('referralStudentSelect').value;
            const date = document.getElementById('referralDate').value;
            const time = document.getElementById('referralTime').value;
            const location = document.getElementById('referralLocation').value;
            const behaviorType = document.getElementById('referralBehaviorType').value;
            const severity = document.querySelector('input[name="referralSeverity"]:checked')?.value;
            const description = document.getElementById('referralDescription').value.trim();
            
            // Validation
            if (!studentId) {
                alert('⚠️ Please select a student');
                return;
            }
            if (!date) {
                alert('⚠️ Please select a date');
                return;
            }
            if (!time) {
                alert('⚠️ Please select a time');
                return;
            }
            if (!location) {
                alert('⚠️ Please select a location');
                return;
            }
            if (!behaviorType) {
                alert('⚠️ Please select a behavior type');
                return;
            }
            if (!severity) {
                alert('⚠️ Please select a severity level');
                return;
            }
            if (!description) {
                alert('⚠️ Please provide a description of the incident');
                return;
            }
            
            const student = students.find(s => s.id === studentId);
            if (!student) {
                alert('⚠️ Student not found');
                return;
            }
            
            // Create referral object
            const referral = {
                id: `REF${referralIdCounter++}`,
                studentId: studentId,
                studentName: `${student.firstName} ${student.lastName}`,
                date: date,
                time: time,
                dateTime: `${date}T${time}`,
                location: location,
                behaviorType: behaviorType,
                severity: severity,
                description: description,
                referredBy: currentUser.name,
                referredByUsername: currentUser.username,
                status: 'pending',
                submittedAt: new Date().toISOString(),
                consequence: '',
                adminNotes: '',
                reviewedBy: '',
                reviewedAt: ''
            };
            
            behaviorReferrals.push(referral);
            await saveData();
            
            // Show success message
            alert('✅ Behavior referral submitted successfully!\n\nThe referral has been sent to administration for review.');
            
            // Clear form
            document.getElementById('referralStudentSelect').value = '';
            document.getElementById('referralDate').value = '';
            document.getElementById('referralTime').value = '';
            document.getElementById('referralLocation').value = '';
            document.getElementById('referralBehaviorType').value = '';
            document.querySelectorAll('input[name="referralSeverity"]').forEach(radio => {
                radio.checked = false;
                radio.parentElement.style.borderColor = '#e0e0e0';
                radio.parentElement.style.background = 'white';
            });
            document.getElementById('referralDescription').value = '';
        }

        function updateReferralReviewTable() {
            const tbody = document.getElementById('referralReviewTableBody');
            const statusFilter = document.getElementById('reviewFilterStatus').value;
            const severityFilter = document.getElementById('reviewFilterSeverity').value;
            
            // Filter referrals
            let filtered = behaviorReferrals;
            if (statusFilter !== 'all') {
                filtered = filtered.filter(r => r.status === statusFilter);
            }
            if (severityFilter !== 'all') {
                filtered = filtered.filter(r => r.severity === severityFilter);
            }
            
            // Sort by date (newest first)
            filtered.sort((a, b) => new Date(b.dateTime) - new Date(a.dateTime));
            
            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px; color: #999;">No referrals match the current filters</td></tr>';
                return;
            }
            
            tbody.innerHTML = filtered.map(ref => {
                const severityColor = ref.severity === 'Minor' ? '#10b981' : ref.severity === 'Major' ? '#f59e0b' : '#dc3545';
                const statusBadge = ref.status === 'pending' 
                    ? '<span style="background: #fef3c7; color: #d97706; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600;">Pending</span>'
                    : '<span style="background: #d1fae5; color: #059669; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600;">Reviewed</span>';
                
                return `
                    <tr style="border-bottom: 1px solid #e5e7eb;">
                        <td style="padding: 16px;">${new Date(ref.dateTime).toLocaleString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'})}</td>
                        <td style="padding: 16px; font-weight: 600;">${ref.studentName}</td>
                        <td style="padding: 16px;">${ref.behaviorType}</td>
                        <td style="padding: 16px; text-align: center;">
                            <span style="background: ${severityColor}; color: white; padding: 6px 14px; border-radius: 14px; font-size: 12px; font-weight: 600;">
                                ${ref.severity}
                            </span>
                        </td>
                        <td style="padding: 16px;">${ref.location}</td>
                        <td style="padding: 16px;">${ref.referredBy}</td>
                        <td style="padding: 16px; text-align: center;">${statusBadge}</td>
                        <td style="padding: 16px; text-align: center;">
                            ${ref.status === 'pending' ? 
                                `<button class="btn btn-sm" onclick="reviewReferral('${ref.id}')" style="padding: 6px 12px; font-size: 13px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">Review</button>` :
                                `<button class="btn btn-sm" onclick="viewReferralDetails('${ref.id}')" style="padding: 6px 12px; font-size: 13px; background: #6c757d;">View</button>`
                            }
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function reviewReferral(referralId) {
            const referral = behaviorReferrals.find(r => r.id === referralId);
            if (!referral) {
                alert('⚠️ Referral not found');
                return;
            }
            
            const student = students.find(s => s.id === referral.studentId);
            if (!student) {
                alert('⚠️ Student not found');
                return;
            }
            
            // Show review modal
            const severityColor = referral.severity === 'Minor' ? '#10b981' : referral.severity === 'Major' ? '#f59e0b' : '#dc3545';
            
            const html = `
                <div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 20px;" id="reviewReferralModal" onclick="if(event.target === this) document.getElementById('reviewReferralModal').remove();">
                    <div style="background: white; border-radius: 16px; max-width: 700px; width: 100%; max-height: 90vh; overflow-y: auto;" onclick="event.stopPropagation();">
                        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 16px 16px 0 0; color: white;">
                            <h2 style="margin: 0 0 10px 0;">📋 Review Behavior Referral</h2>
                            <p style="margin: 0; opacity: 0.9; font-size: 14px;">Referral ID: ${referral.id}</p>
                        </div>
                        
                        <div style="padding: 30px;">
                            <!-- Referral Details -->
                            <div style="background: #f9fafb; padding: 20px; border-radius: 12px; margin-bottom: 25px;">
                                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-bottom: 15px;">
                                    <div>
                                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Student</div>
                                        <div style="font-weight: 600; font-size: 16px;">${referral.studentName}</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Date & Time</div>
                                        <div style="font-weight: 600;">${new Date(referral.dateTime).toLocaleString()}</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Location</div>
                                        <div style="font-weight: 600;">${referral.location}</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Severity</div>
                                        <div><span style="background: ${severityColor}; color: white; padding: 6px 14px; border-radius: 14px; font-size: 13px; font-weight: 600;">${referral.severity}</span></div>
                                    </div>
                                </div>
                                <div style="margin-bottom: 15px;">
                                    <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Behavior Type</div>
                                    <div style="font-weight: 600;">${referral.behaviorType}</div>
                                </div>
                                <div>
                                    <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Description</div>
                                    <div style="padding: 12px; background: white; border-radius: 6px; border: 1px solid #e5e7eb;">${referral.description}</div>
                                </div>
                                <div style="margin-top: 15px;">
                                    <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Referred By</div>
                                    <div style="font-weight: 600;">${referral.referredBy}</div>
                                </div>
                            </div>
                            
                            <!-- Consequence Assignment -->
                            <div style="margin-bottom: 25px;">
                                <label style="font-weight: 600; color: #333; margin-bottom: 8px; display: block;">Consequence / Action Taken</label>
                                <textarea id="referralConsequence" rows="3" placeholder="Enter consequence or action taken..." style="width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-family: inherit; resize: vertical;">${referral.consequence || ''}</textarea>
                            </div>
                            
                            <!-- Admin Notes -->
                            <div style="margin-bottom: 25px;">
                                <label style="font-weight: 600; color: #333; margin-bottom: 8px; display: block;">Admin Notes (Optional)</label>
                                <textarea id="referralAdminNotes" rows="3" placeholder="Any additional notes or follow-up needed..." style="width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-family: inherit; resize: vertical;">${referral.adminNotes || ''}</textarea>
                            </div>
                            
                            <!-- Ticket/Cash Deduction -->
                            <div style="background: #fef3c7; border: 2px solid #f59e0b; border-radius: 12px; padding: 20px; margin-bottom: 25px;">
                                <h4 style="margin: 0 0 15px 0; color: #d97706;">⚠️ Optional: Apply Consequences to Student Record</h4>
                                <div style="margin-bottom: 15px;">
                                    <label style="display: flex; align-items: center; cursor: pointer;">
                                        <input type="checkbox" id="deductTickets" style="margin-right: 10px; width: 18px; height: 18px;">
                                        <span style="font-weight: 600;">Deduct Raffle Tickets</span>
                                    </label>
                                    <div id="ticketDeductionOptions" style="display: none; margin-top: 10px; padding-left: 28px;">
                                        <input type="number" id="ticketsToDeduct" min="1" max="10" value="1" style="width: 80px; padding: 8px; border: 2px solid #e0e0e0; border-radius: 6px; margin-right: 8px;">
                                        <span style="color: #666;">tickets</span>
                                    </div>
                                </div>
                                <div>
                                    <label style="display: flex; align-items: center; cursor: pointer;">
                                        <input type="checkbox" id="deductCash" style="margin-right: 10px; width: 18px; height: 18px;">
                                        <span style="font-weight: 600;">Deduct Wildcat Cash</span>
                                    </label>
                                    <div id="cashDeductionOptions" style="display: none; margin-top: 10px; padding-left: 28px;">
                                        <span style="margin-right: 8px;">$</span>
                                        <input type="number" id="cashToDeduct" min="50" step="50" value="100" style="width: 100px; padding: 8px; border: 2px solid #e0e0e0; border-radius: 6px;">
                                    </div>
                                </div>
                            </div>
                            
                            <!-- Email Parent -->
                            <div style="background: #e0f2fe; border: 2px solid #0ea5e9; border-radius: 12px; padding: 20px; margin-bottom: 25px;">
                                <label style="display: flex; align-items: center; cursor: pointer;">
                                    <input type="checkbox" id="emailParent" style="margin-right: 10px; width: 18px; height: 18px;">
                                    <span style="font-weight: 600;">📧 Email Parent/Guardian</span>
                                </label>
                                <p style="margin: 10px 0 0 28px; font-size: 13px; color: #666;">Send an automated notification email about this incident</p>
                            </div>
                            
                            <!-- Action Buttons -->
                            <div style="display: flex; gap: 10px;">
                                <button class="btn" onclick="saveReferralReview('${referral.id}')" style="flex: 1; background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 14px; font-size: 16px; font-weight: 600;">
                                    ✓ Complete Review
                                </button>
                                <button class="btn btn-secondary" onclick="document.getElementById('reviewReferralModal').remove()" style="padding: 14px 24px;">
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            document.body.insertAdjacentHTML('beforeend', html);
            
            // Add checkbox listeners
            document.getElementById('deductTickets').addEventListener('change', (e) => {
                document.getElementById('ticketDeductionOptions').style.display = e.target.checked ? 'block' : 'none';
            });
            document.getElementById('deductCash').addEventListener('change', (e) => {
                document.getElementById('cashDeductionOptions').style.display = e.target.checked ? 'block' : 'none';
            });
        }

        async function saveReferralReview(referralId) {
            const referral = behaviorReferrals.find(r => r.id === referralId);
            if (!referral) {
                alert('⚠️ Referral not found');
                return;
            }
            
            const student = students.find(s => s.id === referral.studentId);
            if (!student) {
                alert('⚠️ Student not found');
                return;
            }
            
            const consequence = document.getElementById('referralConsequence').value.trim();
            const adminNotes = document.getElementById('referralAdminNotes').value.trim();
            const deductTickets = document.getElementById('deductTickets').checked;
            const deductCash = document.getElementById('deductCash').checked;
            const emailParent = document.getElementById('emailParent').checked;
            
            if (!consequence) {
                alert('⚠️ Please enter a consequence or action taken');
                return;
            }
            
            // Update referral
            referral.consequence = consequence;
            referral.adminNotes = adminNotes;
            referral.status = 'reviewed';
            referral.reviewedBy = currentUser.name;
            referral.reviewedAt = new Date().toISOString();
            
            // Apply ticket deduction
            if (deductTickets) {
                const ticketsToDeduct = parseInt(document.getElementById('ticketsToDeduct').value) || 1;
                student.pbisTickets = Math.max(0, (student.pbisTickets || 0) - ticketsToDeduct);
                
                // Log in history
                if (!student.ticketHistory) student.ticketHistory = [];
                student.ticketHistory.push({
                    type: 'pbis',
                    subcategory: `Behavior Referral - ${referral.behaviorType}`,
                    amount: -ticketsToDeduct,
                    teacher: currentUser.name,
                    timestamp: new Date().toISOString(),
                    week: currentWeek,
                    notes: `Deducted due to referral ${referral.id}: ${referral.behaviorType} (${referral.severity})`
                });
                
                referral.ticketsDeducted = ticketsToDeduct;
            }
            
            // Apply cash deduction
            if (deductCash) {
                const cashToDeduct = parseInt(document.getElementById('cashToDeduct').value) || 100;
                student.wildcatCashBalance = Math.max(0, (student.wildcatCashBalance || 0) - cashToDeduct);
                student.wildcatCashDeducted = (student.wildcatCashDeducted || 0) + cashToDeduct;
                
                // Log transaction
                if (!student.wildcatCashTransactions) student.wildcatCashTransactions = [];
                student.wildcatCashTransactions.push({
                    type: 'negative',
                    amount: -cashToDeduct,
                    category: `Behavior Referral - ${referral.behaviorType}`,
                    teacher: currentUser.name,
                    timestamp: new Date().toISOString(),
                    notes: `Deducted due to referral ${referral.id}: ${referral.behaviorType} (${referral.severity})`
                });
                
                referral.cashDeducted = cashToDeduct;
            }
            
            // Send email if requested
            if (emailParent && emailJSConfig.publicKey && typeof emailjs !== 'undefined') {
                try {
                    const emailParams = {
                        to_email: student.email || 'parent@example.com', // You'd need to add parent email to student records
                        student_name: `${student.firstName} ${student.lastName}`,
                        behavior_type: referral.behaviorType,
                        severity: referral.severity,
                        date: new Date(referral.dateTime).toLocaleDateString(),
                        location: referral.location,
                        description: referral.description,
                        consequence: consequence,
                        admin_name: currentUser.name
                    };
                    
                    await emailjs.send(emailJSConfig.serviceId, 'behavior_referral_template', emailParams);
                    referral.parentNotified = true;
                } catch (error) {
                    console.error('Failed to send parent email:', error);
                }
            }
            
            await saveData();
            
            // Close modal
            document.getElementById('reviewReferralModal').remove();
            
            // Show success
            alert('✅ Referral review completed and saved!');
            
            // Refresh the review table
            updateReferralReviewTable();
        }

        function viewReferralDetails(referralId) {
            const referral = behaviorReferrals.find(r => r.id === referralId);
            if (!referral) {
                alert('⚠️ Referral not found');
                return;
            }
            
            const severityColor = referral.severity === 'Minor' ? '#10b981' : referral.severity === 'Major' ? '#f59e0b' : '#dc3545';
            
            const html = `
                <div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 20px;" id="viewReferralModal" onclick="if(event.target === this) document.getElementById('viewReferralModal').remove();">
                    <div style="background: white; border-radius: 16px; max-width: 700px; width: 100%; max-height: 90vh; overflow-y: auto;" onclick="event.stopPropagation();">
                        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 16px 16px 0 0; color: white;">
                            <h2 style="margin: 0 0 10px 0;">📋 Referral Details</h2>
                            <p style="margin: 0; opacity: 0.9; font-size: 14px;">Referral ID: ${referral.id} • Reviewed by ${referral.reviewedBy}</p>
                        </div>
                        
                        <div style="padding: 30px;">
                            <div style="background: #f9fafb; padding: 20px; border-radius: 12px; margin-bottom: 20px;">
                                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-bottom: 15px;">
                                    <div>
                                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Student</div>
                                        <div style="font-weight: 600; font-size: 16px;">${referral.studentName}</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Date & Time</div>
                                        <div style="font-weight: 600;">${new Date(referral.dateTime).toLocaleString()}</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Location</div>
                                        <div style="font-weight: 600;">${referral.location}</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Severity</div>
                                        <div><span style="background: ${severityColor}; color: white; padding: 6px 14px; border-radius: 14px; font-size: 13px; font-weight: 600;">${referral.severity}</span></div>
                                    </div>
                                </div>
                                <div style="margin-bottom: 15px;">
                                    <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Behavior Type</div>
                                    <div style="font-weight: 600;">${referral.behaviorType}</div>
                                </div>
                                <div style="margin-bottom: 15px;">
                                    <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Description</div>
                                    <div style="padding: 12px; background: white; border-radius: 6px; border: 1px solid #e5e7eb;">${referral.description}</div>
                                </div>
                                <div>
                                    <div style="font-size: 12px; color: #666; margin-bottom: 4px;">Referred By</div>
                                    <div style="font-weight: 600;">${referral.referredBy}</div>
                                </div>
                            </div>
                            
                            <div style="background: #e0f2fe; padding: 20px; border-radius: 12px; margin-bottom: 20px;">
                                <div style="font-size: 12px; color: #0369a1; margin-bottom: 4px; font-weight: 600;">CONSEQUENCE / ACTION TAKEN</div>
                                <div style="padding: 12px; background: white; border-radius: 6px;">${referral.consequence}</div>
                            </div>
                            
                            ${referral.adminNotes ? `
                                <div style="background: #fef3c7; padding: 20px; border-radius: 12px; margin-bottom: 20px;">
                                    <div style="font-size: 12px; color: #d97706; margin-bottom: 4px; font-weight: 600;">ADMIN NOTES</div>
                                    <div style="padding: 12px; background: white; border-radius: 6px;">${referral.adminNotes}</div>
                                </div>
                            ` : ''}
                            
                            ${referral.ticketsDeducted || referral.cashDeducted ? `
                                <div style="background: #fee2e2; padding: 15px; border-radius: 12px; margin-bottom: 20px;">
                                    <div style="font-size: 12px; color: #dc2626; margin-bottom: 8px; font-weight: 600;">CONSEQUENCES APPLIED</div>
                                    ${referral.ticketsDeducted ? `<div style="margin-bottom: 5px;">🎫 Deducted ${referral.ticketsDeducted} ticket(s)</div>` : ''}
                                    ${referral.cashDeducted ? `<div>💰 Deducted $${referral.cashDeducted}</div>` : ''}
                                </div>
                            ` : ''}
                            
                            <div style="text-align: center;">
                                <button class="btn btn-secondary" onclick="document.getElementById('viewReferralModal').remove()" style="padding: 12px 30px;">
                                    Close
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            document.body.insertAdjacentHTML('beforeend', html);
        }

        function updateStudentReferralHistory() {
            const studentId = document.getElementById('historyStudentSelect').value;
            
            if (!studentId) {
                document.getElementById('studentReferralSummary').classList.add('hidden');
                document.getElementById('studentReferralHistoryContainer').classList.add('hidden');
                document.getElementById('noHistoryMessage').classList.add('hidden');
                return;
            }
            
            const student = students.find(s => s.id === studentId);
            if (!student) return;
            
            const studentReferrals = behaviorReferrals.filter(r => r.studentId === studentId);
            
            if (studentReferrals.length === 0) {
                document.getElementById('studentReferralSummary').classList.add('hidden');
                document.getElementById('studentReferralHistoryContainer').classList.add('hidden');
                document.getElementById('noHistoryMessage').classList.remove('hidden');
                return;
            }
            
            // Show summary
            document.getElementById('studentReferralSummary').classList.remove('hidden');
            document.getElementById('noHistoryMessage').classList.add('hidden');
            
            const minorCount = studentReferrals.filter(r => r.severity === 'Minor').length;
            const majorCount = studentReferrals.filter(r => r.severity === 'Major').length;
            const severeCount = studentReferrals.filter(r => r.severity === 'Severe').length;
            
            document.getElementById('summaryMinor').textContent = minorCount;
            document.getElementById('summaryMajor').textContent = majorCount;
            document.getElementById('summarySevere').textContent = severeCount;
            document.getElementById('summaryTotal').textContent = studentReferrals.length;
            
            // Show history table
            document.getElementById('studentReferralHistoryContainer').classList.remove('hidden');
            const tbody = document.getElementById('studentReferralHistoryBody');
            
            const sorted = [...studentReferrals].sort((a, b) => new Date(b.dateTime) - new Date(a.dateTime));
            
            tbody.innerHTML = sorted.map(ref => {
                const severityColor = ref.severity === 'Minor' ? '#10b981' : ref.severity === 'Major' ? '#f59e0b' : '#dc3545';
                
                return `
                    <tr style="border-bottom: 1px solid #e5e7eb;">
                        <td style="padding: 14px;">${new Date(ref.dateTime).toLocaleDateString()}</td>
                        <td style="padding: 14px;">${ref.behaviorType}</td>
                        <td style="padding: 14px; text-align: center;">
                            <span style="background: ${severityColor}; color: white; padding: 5px 12px; border-radius: 12px; font-size: 12px; font-weight: 600;">
                                ${ref.severity}
                            </span>
                        </td>
                        <td style="padding: 14px;">${ref.location}</td>
                        <td style="padding: 14px;">${ref.referredBy}</td>
                        <td style="padding: 14px;">${ref.consequence || '<span style="color: #999;">Pending</span>'}</td>
                        <td style="padding: 14px; text-align: center;">
                            <button class="btn btn-sm" onclick="viewReferralDetails('${ref.id}')" style="padding: 5px 12px; font-size: 12px; background: #6c757d;">View</button>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function updateReferralAnalytics() {
            // Update summary cards
            const totalReferrals = behaviorReferrals.length;
            const now = new Date();
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const thisWeek = behaviorReferrals.filter(r => new Date(r.submittedAt) >= weekAgo).length;
            const pending = behaviorReferrals.filter(r => r.status === 'pending').length;
            const uniqueStudents = new Set(behaviorReferrals.map(r => r.studentId)).size;
            
            document.getElementById('analyticsTotalReferrals').textContent = totalReferrals;
            document.getElementById('analyticsThisWeek').textContent = thisWeek;
            document.getElementById('analyticsPending').textContent = pending;
            document.getElementById('analyticsStudents').textContent = uniqueStudents;
            
            // Behavior Type Chart
            const behaviorCounts = {};
            behaviorReferrals.forEach(r => {
                behaviorCounts[r.behaviorType] = (behaviorCounts[r.behaviorType] || 0) + 1;
            });
            
            const behaviorTypeCtx = document.getElementById('behaviorTypeChart');
            if (behaviorTypeCtx) {
                if (window.behaviorTypeChartInstance) {
                    window.behaviorTypeChartInstance.destroy();
                }
                window.behaviorTypeChartInstance = new Chart(behaviorTypeCtx, {
                    type: 'bar',
                    data: {
                        labels: Object.keys(behaviorCounts),
                        datasets: [{
                            label: 'Number of Referrals',
                            data: Object.values(behaviorCounts),
                            backgroundColor: 'rgba(102, 126, 234, 0.7)',
                            borderColor: 'rgba(102, 126, 234, 1)',
                            borderWidth: 2
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        plugins: {
                            legend: { display: false }
                        },
                        scales: {
                            y: {
                                beginAtZero: true,
                                ticks: { stepSize: 1 }
                            }
                        }
                    }
                });
            }
            
            // Severity Chart
            const severityCounts = {
                Minor: behaviorReferrals.filter(r => r.severity === 'Minor').length,
                Major: behaviorReferrals.filter(r => r.severity === 'Major').length,
                Severe: behaviorReferrals.filter(r => r.severity === 'Severe').length
            };
            
            const severityCtx = document.getElementById('severityChart');
            if (severityCtx) {
                if (window.severityChartInstance) {
                    window.severityChartInstance.destroy();
                }
                window.severityChartInstance = new Chart(severityCtx, {
                    type: 'doughnut',
                    data: {
                        labels: ['Minor', 'Major', 'Severe'],
                        datasets: [{
                            data: [severityCounts.Minor, severityCounts.Major, severityCounts.Severe],
                            backgroundColor: ['#10b981', '#f59e0b', '#dc3545'],
                            borderWidth: 2,
                            borderColor: '#fff'
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        plugins: {
                            legend: {
                                position: 'bottom'
                            }
                        }
                    }
                });
            }
        }
        
        // ========================================
        // DETENTION TRACKER FUNCTIONS
        // ========================================
        
        let currentDetentionLevel = 'ms'; // 'ms' or 'hs'
        
        function initializeDetentionForm() {
            // Set today's date as default
            const today = new Date().toISOString().split('T')[0];
            document.getElementById('detentionDateAssigned').value = today;
            document.getElementById('detentionStartDate').value = today;
            
            // Populate location dropdown
            const locationSelect = document.getElementById('detentionLocation');
            locationSelect.innerHTML = '<option value="">Select location...</option>' +
                detentionLocations.map(loc => `<option value="${loc}">${loc}</option>`).join('');
            
            // Populate reason dropdown
            const reasonSelect = document.getElementById('detentionReason');
            reasonSelect.innerHTML = '<option value="">Select reason...</option>' +
                detentionReasons.map(reason => `<option value="${reason}">${reason}</option>`).join('');
        }
        
        function switchDetentionLevel(level) {
            currentDetentionLevel = level;
            
            // Update button styles
            document.querySelectorAll('.detention-level-btn').forEach(btn => {
                btn.style.background = '#f5f5f5';
                btn.style.color = '#333';
            });
            
            const activeBtn = document.getElementById(level === 'ms' ? 'detentionMSBtn' : 'detentionHSBtn');
            if (level === 'ms') {
                activeBtn.style.background = 'linear-gradient(135deg, #ff9800 0%, #f57c00 100%)';
            } else {
                activeBtn.style.background = 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)';
            }
            activeBtn.style.color = 'white';
            
            // Refresh detention lists
            updateDetentionLists();
        }
        
        function searchStudentsForDetention() {
            const searchTerm = document.getElementById('detentionStudentSearch').value.trim().toLowerCase();
            const resultsDiv = document.getElementById('detentionStudentResults');
            
            if (searchTerm.length < 2) {
                resultsDiv.style.display = 'none';
                return;
            }
            
            // Filter by current detention level (MS or HS)
            const filteredStudents = students.filter(s => {
                const grade = parseInt(s.grade);
                const levelMatch = currentDetentionLevel === 'ms' ? (grade >= 6 && grade <= 8) : (grade >= 9 && grade <= 12);
                
                if (!levelMatch) return false;
                
                const fullName = `${s.firstName} ${s.lastName}`.toLowerCase();
                const reverseName = `${s.lastName} ${s.firstName}`.toLowerCase();
                const studentId = (s.studentId || '').toLowerCase();
                
                return fullName.includes(searchTerm) || reverseName.includes(searchTerm) || studentId.includes(searchTerm);
            });
            
            if (filteredStudents.length === 0) {
                resultsDiv.innerHTML = '<div style="padding: 10px; color: #999;">No students found</div>';
                resultsDiv.style.display = 'block';
                return;
            }
            
            resultsDiv.innerHTML = filteredStudents.slice(0, 10).map(s => `
                <div onclick="selectDetentionStudent('${s.id}')" style="padding: 10px; cursor: pointer; border-bottom: 1px solid #eee; transition: background 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">
                    <strong>${s.firstName} ${s.lastName}</strong>
                    <small style="color: #666; margin-left: 10px;">Grade ${s.grade} ${s.studentId ? '• ID: ' + s.studentId : ''}</small>
                </div>
            `).join('');
            
            resultsDiv.style.display = 'block';
        }
        
        function selectDetentionStudent(studentId) {
            const student = students.find(s => s.id === studentId);
            if (!student) return;
            
            document.getElementById('selectedDetentionStudentId').value = studentId;
            document.getElementById('selectedDetentionStudentName').textContent = `${student.firstName} ${student.lastName} (Grade ${student.grade})`;
            document.getElementById('selectedDetentionStudent').style.display = 'block';
            document.getElementById('detentionStudentResults').style.display = 'none';
            document.getElementById('detentionStudentSearch').value = '';
        }
        
        function clearDetentionStudentSelection() {
            document.getElementById('selectedDetentionStudentId').value = '';
            document.getElementById('selectedDetentionStudent').style.display = 'none';
            document.getElementById('detentionStudentSearch').value = '';
        }
        
        function assignDetention() {
            const studentId = document.getElementById('selectedDetentionStudentId').value;
            const location = document.getElementById('detentionLocation').value;
            const dateAssigned = document.getElementById('detentionDateAssigned').value;
            const totalDays = parseInt(document.getElementById('detentionTotalDays').value);
            const startDate = document.getElementById('detentionStartDate').value;
            const reason = document.getElementById('detentionReason').value.trim();
            
            // Validation
            if (!studentId) {
                alert('⚠️ Please select a student');
                return;
            }
            if (!location) {
                alert('⚠️ Please select a location');
                return;
            }
            if (!dateAssigned) {
                alert('⚠️ Please enter the date detention was assigned');
                return;
            }
            if (!totalDays || totalDays < 1) {
                alert('⚠️ Please enter a valid number of days (1-30)');
                return;
            }
            if (!startDate) {
                alert('⚠️ Please enter the start date');
                return;
            }
            if (!reason) {
                alert('⚠️ Please enter a reason for detention');
                return;
            }
            
            const student = students.find(s => s.id === studentId);
            if (!student) return;
            
            // Create detention record
            const detention = {
                id: 'detention_' + detentionIdCounter++,
                studentId: studentId,
                studentName: `${student.firstName} ${student.lastName}`,
                grade: student.grade,
                location: location,
                dateAssigned: dateAssigned,
                totalDays: totalDays,
                daysServed: 0,
                daysRemaining: totalDays,
                startDate: startDate,
                reason: reason,
                status: 'active', // 'active' or 'completed'
                assignedBy: currentUser.name,
                assignedAt: new Date().toISOString(),
                servedDates: [], // Array of dates when detention was served
                completedAt: null
            };
            
            detentions.push(detention);
            saveData();
            
            // Clear form
            clearDetentionStudentSelection();
            document.getElementById('detentionLocation').value = '';
            document.getElementById('detentionDateAssigned').value = '';
            document.getElementById('detentionTotalDays').value = '1';
            document.getElementById('detentionStartDate').value = '';
            document.getElementById('detentionReason').value = '';
            
            updateDetentionLists();
            
            showSuccessToast(`✅ Detention assigned to ${student.firstName} ${student.lastName}`);
        }
        
        function updateDetentionLists() {
            // Filter detentions by current level (MS or HS)
            const levelDetentions = detentions.filter(d => {
                const grade = parseInt(d.grade);
                return currentDetentionLevel === 'ms' ? (grade >= 6 && grade <= 8) : (grade >= 9 && grade <= 12);
            });
            
            const active = levelDetentions.filter(d => d.status === 'active');
            const completed = levelDetentions.filter(d => d.status === 'completed');
            
            // Update counts
            document.getElementById('activeDetentionCount').textContent = `${active.length} Active`;
            document.getElementById('completedDetentionCount').textContent = `${completed.length} Completed`;
            
            // Render active detentions
            const activeList = document.getElementById('activeDetentionsList');
            if (active.length === 0) {
                activeList.innerHTML = '<p style="text-align: center; color: #999; padding: 40px;">No active detentions</p>';
            } else {
                activeList.innerHTML = active.map(d => renderDetentionCard(d, true)).join('');
            }
            
            // Render completed detentions
            const completedList = document.getElementById('completedDetentionsList');
            if (completed.length === 0) {
                completedList.innerHTML = '<p style="text-align: center; color: #999; padding: 40px;">No completed detentions</p>';
            } else {
                completedList.innerHTML = completed.map(d => renderDetentionCard(d, false)).join('');
            }
        }
        
        function renderDetentionCard(detention, isActive) {
            const progressPercent = detention.totalDays > 0 ? (detention.daysServed / detention.totalDays * 100) : 0;
            
            return `
                <div style="border: 2px solid ${isActive ? '#dc3545' : '#28a745'}; border-radius: 8px; padding: 20px; margin-bottom: 15px; background: ${isActive ? '#fff5f5' : '#f0fdf4'};">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 15px;">
                        <div>
                            <h4 style="margin: 0 0 5px 0; color: #333;">${detention.studentName}</h4>
                            <small style="color: #666;">Grade ${detention.grade} • Assigned ${new Date(detention.dateAssigned).toLocaleDateString()}</small>
                        </div>
                        <div style="text-align: right;">
                            <div style="padding: 6px 12px; background: ${isActive ? '#dc3545' : '#28a745'}; color: white; border-radius: 20px; font-size: 12px; font-weight: 600; margin-bottom: 5px;">
                                ${isActive ? 'ACTIVE' : 'COMPLETED'}
                            </div>
                            <small style="color: #666;">ID: ${detention.id.split('_')[1]}</small>
                        </div>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 15px;">
                        <div>
                            <small style="color: #666;">Location</small>
                            <div style="font-weight: 600;">${detention.location}</div>
                        </div>
                        <div>
                            <small style="color: #666;">Start Date</small>
                            <div style="font-weight: 600;">${new Date(detention.startDate).toLocaleDateString()}</div>
                        </div>
                        <div>
                            <small style="color: #666;">Days Served</small>
                            <div style="font-weight: 600; color: ${isActive ? '#dc3545' : '#28a745'};">${detention.daysServed} / ${detention.totalDays}</div>
                        </div>
                        <div>
                            <small style="color: #666;">Remaining</small>
                            <div style="font-weight: 600;">${detention.daysRemaining} days</div>
                        </div>
                    </div>
                    
                    <div style="margin-bottom: 15px;">
                        <small style="color: #666;">Reason</small>
                        <div style="margin-top: 5px;">${detention.reason}</div>
                    </div>
                    
                    <!-- Progress Bar -->
                    <div style="background: #e0e0e0; border-radius: 10px; height: 20px; overflow: hidden; margin-bottom: 15px;">
                        <div style="background: ${isActive ? 'linear-gradient(90deg, #dc3545, #c82333)' : 'linear-gradient(90deg, #28a745, #218838)'}; height: 100%; width: ${progressPercent}%; transition: width 0.3s; display: flex; align-items: center; justify-content: center; color: white; font-size: 11px; font-weight: 600;">
                            ${progressPercent.toFixed(0)}%
                        </div>
                    </div>
                    
                    <div style="display: flex; gap: 10px;">
                        ${isActive ? `
                            <button onclick="markDetentionDay('${detention.id}')" style="flex: 1; padding: 10px; background: #28a745; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">
                                ✅ Mark Day Served
                            </button>
                            <button onclick="editDetention('${detention.id}')" style="padding: 10px 20px; background: #ffc107; color: #333; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">
                                ✏️ Edit
                            </button>
                        ` : `
                            <div style="flex: 1; padding: 10px; background: #28a745; color: white; border-radius: 6px; text-align: center; font-weight: 600;">
                                ✅ Completed ${detention.completedAt ? new Date(detention.completedAt).toLocaleDateString() : ''}
                            </div>
                        `}
                        <button onclick="viewDetentionDetails('${detention.id}')" style="padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">
                            👁️ Details
                        </button>
                    </div>
                </div>
            `;
        }
        
        function markDetentionDay(detentionId) {
            const detention = detentions.find(d => d.id === detentionId);
            if (!detention || detention.status !== 'active') return;
            
            const today = new Date().toISOString().split('T')[0];
            
            // Initialize attendance records if not exists
            if (!detention.attendanceRecords) {
                detention.attendanceRecords = [];
            }
            
            // Check if already marked today
            const existingRecord = detention.attendanceRecords.find(r => r.date === today);
            if (existingRecord) {
                alert(`⚠️ Attendance already marked for today as: ${existingRecord.status}\n\nDate: ${new Date(today).toLocaleDateString()}`);
                return;
            }
            
            // Ask for attendance status
            const attendance = confirm(
                `📋 DETENTION ATTENDANCE\n\n` +
                `Student: ${detention.studentName}\n` +
                `Date: ${new Date(today).toLocaleDateString()}\n\n` +
                `Was the student PRESENT for detention today?\n\n` +
                `Click OK for PRESENT\n` +
                `Click Cancel for ABSENT`
            );
            
            const status = attendance ? 'present' : 'absent';
            
            // Record attendance
            detention.attendanceRecords.push({
                date: today,
                status: status,
                markedBy: currentUser.name,
                markedAt: new Date().toISOString()
            });
            
            // Only increment days served if PRESENT
            if (status === 'present') {
                detention.daysServed++;
                detention.daysRemaining = detention.totalDays - detention.daysServed;
                detention.servedDates.push(today);
                
                // Check if completed
                if (detention.daysServed >= detention.totalDays) {
                    detention.status = 'completed';
                    detention.completedAt = new Date().toISOString();
                    showSuccessToast(`🎉 ${detention.studentName} has completed their detention!`);
                } else {
                    showSuccessToast(`✅ PRESENT - Day marked for ${detention.studentName} (${detention.daysServed}/${detention.totalDays})`);
                }
            } else {
                // Absent - no credit for the day
                showSuccessToast(`⚠️ ABSENT - ${detention.studentName} was marked absent. No credit given.`);
            }
            
            saveData();
            updateDetentionLists();
        }
        
        function editDetention(detentionId) {
            const detention = detentions.find(d => d.id === detentionId);
            if (!detention) return;
            
            const newDays = prompt(`Edit total detention days for ${detention.studentName}\n\nCurrent: ${detention.totalDays} days\nServed: ${detention.daysServed} days\n\nEnter new total days (must be >= days served):`, detention.totalDays);
            
            if (newDays === null) return; // Cancelled
            
            const parsedDays = parseInt(newDays);
            if (isNaN(parsedDays) || parsedDays < detention.daysServed) {
                alert('⚠️ Invalid number. Total days must be at least ' + detention.daysServed);
                return;
            }
            
            detention.totalDays = parsedDays;
            detention.daysRemaining = parsedDays - detention.daysServed;
            
            // Reactivate if was completed but days increased
            if (detention.status === 'completed' && detention.daysRemaining > 0) {
                detention.status = 'active';
                detention.completedAt = null;
            }
            
            saveData();
            updateDetentionLists();
            showSuccessToast(`✅ Detention updated for ${detention.studentName}`);
        }
        
        function viewDetentionDetails(detentionId) {
            const detention = detentions.find(d => d.id === detentionId);
            if (!detention) return;
            
            const servedDatesText = detention.servedDates.length > 0 
                ? detention.servedDates.map(d => new Date(d).toLocaleDateString()).join(', ')
                : 'None yet';
            
            // Build attendance record text
            let attendanceText = '';
            if (detention.attendanceRecords && detention.attendanceRecords.length > 0) {
                attendanceText = '\n\nAttendance Records:\n' + detention.attendanceRecords.map(r => 
                    `${new Date(r.date).toLocaleDateString()}: ${r.status.toUpperCase()}`
                ).join('\n');
            }
            
            alert(
                `📋 DETENTION DETAILS\n\n` +
                `Student: ${detention.studentName}\n` +
                `Grade: ${detention.grade}\n\n` +
                `Location: ${detention.location}\n` +
                `Date Assigned: ${new Date(detention.dateAssigned).toLocaleDateString()}\n` +
                `Start Date: ${new Date(detention.startDate).toLocaleDateString()}\n\n` +
                `Total Days: ${detention.totalDays}\n` +
                `Days Served: ${detention.daysServed}\n` +
                `Days Remaining: ${detention.daysRemaining}\n\n` +
                `Status: ${detention.status.toUpperCase()}\n` +
                (detention.completedAt ? `Completed: ${new Date(detention.completedAt).toLocaleDateString()}\n\n` : '\n') +
                `Reason: ${detention.reason}\n\n` +
                `Dates Served:\n${servedDatesText}` +
                attendanceText + `\n\n` +
                `Assigned By: ${detention.assignedBy}\n` +
                `Assigned At: ${new Date(detention.assignedAt).toLocaleString()}`
            );
        }
        
        // ========================================
        // DETENTION SETTINGS FUNCTIONS
        // ========================================
        
        function openDetentionSettings() {
            updateDetentionSettingsLists();
            document.getElementById('detentionSettingsModal').style.display = 'flex';
        }
        
        function closeDetentionSettings() {
            document.getElementById('detentionSettingsModal').style.display = 'none';
            // Refresh dropdowns in main form
            initializeDetentionForm();
        }
        
        function updateDetentionSettingsLists() {
            // Update locations list
            const locationsList = document.getElementById('detentionLocationsList');
            locationsList.innerHTML = detentionLocations.map((loc, index) => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: #f5f5f5; border-radius: 6px; margin-bottom: 8px;">
                    <span>${loc}</span>
                    <button onclick="removeDetentionLocation(${index})" style="padding: 4px 12px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer;">Remove</button>
                </div>
            `).join('');
            
            // Update reasons list
            const reasonsList = document.getElementById('detentionReasonsList');
            reasonsList.innerHTML = detentionReasons.map((reason, index) => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: #f5f5f5; border-radius: 6px; margin-bottom: 8px;">
                    <span>${reason}</span>
                    <button onclick="removeDetentionReason(${index})" style="padding: 4px 12px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer;">Remove</button>
                </div>
            `).join('');
        }
        
        function addDetentionLocation() {
            const input = document.getElementById('newDetentionLocation');
            const newLocation = input.value.trim();
            
            if (!newLocation) {
                alert('⚠️ Please enter a location name');
                return;
            }
            
            if (detentionLocations.includes(newLocation)) {
                alert('⚠️ This location already exists');
                return;
            }
            
            detentionLocations.push(newLocation);
            input.value = '';
            updateDetentionSettingsLists();
            saveData();
            showSuccessToast(`✅ Location "${newLocation}" added`);
        }
        
        function removeDetentionLocation(index) {
            const location = detentionLocations[index];
            if (confirm(`Remove location "${location}"?`)) {
                detentionLocations.splice(index, 1);
                updateDetentionSettingsLists();
                saveData();
                showSuccessToast(`✅ Location "${location}" removed`);
            }
        }
        
        function addDetentionReason() {
            const input = document.getElementById('newDetentionReason');
            const newReason = input.value.trim();
            
            if (!newReason) {
                alert('⚠️ Please enter a reason');
                return;
            }
            
            if (detentionReasons.includes(newReason)) {
                alert('⚠️ This reason already exists');
                return;
            }
            
            detentionReasons.push(newReason);
            input.value = '';
            updateDetentionSettingsLists();
            saveData();
            showSuccessToast(`✅ Reason "${newReason}" added`);
        }
        
        function removeDetentionReason(index) {
            const reason = detentionReasons[index];
            if (confirm(`Remove reason "${reason}"?`)) {
                detentionReasons.splice(index, 1);
                updateDetentionSettingsLists();
                saveData();
                showSuccessToast(`✅ Reason "${reason}" removed`);
            }
        }

        function exportReferralReport() {
            if (behaviorReferrals.length === 0) {
                alert('No referral data to export');
                return;
            }
            
            // Create workbook
            const wb = XLSX.utils.book_new();
            
            // Prepare data
            const data = behaviorReferrals.map(r => ({
                'Referral ID': r.id,
                'Date': new Date(r.dateTime).toLocaleDateString(),
                'Time': new Date(r.dateTime).toLocaleTimeString(),
                'Student Name': r.studentName,
                'Behavior Type': r.behaviorType,
                'Severity': r.severity,
                'Location': r.location,
                'Description': r.description,
                'Referred By': r.referredBy,
                'Status': r.status,
                'Consequence': r.consequence || '',
                'Admin Notes': r.adminNotes || '',
                'Reviewed By': r.reviewedBy || '',
                'Tickets Deducted': r.ticketsDeducted || 0,
                'Cash Deducted': r.cashDeducted || 0,
                'Parent Notified': r.parentNotified ? 'Yes' : 'No'
            }));
            
            // Create worksheet
            const ws = XLSX.utils.json_to_sheet(data);
            
            // Add to workbook
            XLSX.utils.book_append_sheet(wb, ws, 'Behavior Referrals');
            
            // Generate file
            const filename = `Behavior_Referrals_${new Date().toISOString().split('T')[0]}.xlsx`;
            XLSX.writeFile(wb, filename);
            
            alert('✅ Referral report exported successfully!');
        }

