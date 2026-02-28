"use client";
import React, { useState, useEffect, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { motion, AnimatePresence } from "framer-motion";
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LineChart, Line } from "recharts";
import { createClient } from "@supabase/supabase-js";


const priorities = [
  { value: "4", label: "🚨 Emergency" },
  { value: "3", label: "⚠️ High" },
  { value: "2", label: "📌 Medium" },
  { value: "1", label: "🟢 Low" },
];

const priorityColor = {
  "4": "#ef4444",
  "3": "#f97316",
  "2": "#3b82f6",
  "1": "#22c55e",
};

const safeParse = (v: string | null) => {
  try {
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
};


const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2) + Date.now().toString(36);

const toISODate = (d: string | number | Date) => {
  const date = new Date(d);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().split("T")[0];
};

// -------------------- Supabase client + helpers --------------------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn("Supabase env vars missing");
}

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;


async function loadProfilesFromDB() {
  if (!supabase) return ["Default"];
  const { data, error } = await supabase.from("profiles").select("name").order("created_at", { ascending: true });
  if (error) {
    console.error("loadProfilesFromDB error", error);
    return ["Default"];
  }
  if (!data || data.length === 0) {
    // create default profile
    await supabase.from("profiles").insert([{ name: "Default" }]);
    return ["Default"];
  }
  return data.map(r => r.name);
}

async function saveProfilesToDB(profiles: string[]) {
  if (!supabase) return;

  try {
    const rows = profiles.map(name => ({ name }));

    await supabase
      .from("profiles")
      .upsert(rows, { onConflict: "name" });

  } catch (e) {
    console.error("saveProfilesToDB error", e);
  }
}


async function loadTasksFromDB(profile) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.from("tasks").select("id, content").eq("profile", profile);
    if (error) {
      console.error("loadTasksFromDB error", error);
      return [];
    }
    // data[i].content is a JSON object if stored as jsonb
    return (data || []).map(r => (typeof r.content === "string" ? safeParse(r.content) || null : r.content)).filter(Boolean);
  } catch (e) {
    console.error("loadTasksFromDB exception", e);
    return [];
  }
}

async function saveTasksToDB(profile: string, tasks: any[]) {
  if (!supabase) return;

  try {
    const rows = tasks.map(t => ({
      id: t.id,
      profile,
      content: t,
      updated_at: new Date().toISOString(),
    }));

    await supabase
      .from("tasks")
      .upsert(rows, { onConflict: "id" });

  } catch (e) {
    console.error("saveTasksToDB error", e);
  }
}

async function cleanupDeletedTasks(profile: string, tasks: any[]) {
  if (!supabase) return;

  const ids = tasks.map(t => t.id);
  if (ids.length === 0) {
    await supabase.from("tasks").delete().eq("profile", profile);
    return;
  }

  await supabase
    .from("tasks")
    .delete()
    .eq("profile", profile)
    .not("id", "in", `(${ids.join(",")})`);
}




// -------------------- TaskNode component (unchanged behavior) --------------------
function TaskNode({ task, onChange, onDelete, level = 0 }) {
  const [expanded, setExpanded] = useState(false);
  const [childTitle, setChildTitle] = useState("");
  const [comment, setComment] = useState("");
  const [openChildren, setOpenChildren] = useState({});
  const [tagInput, setTagInput] = useState("");

  const updateSelf = updates => onChange({ ...task, ...updates });

  const updateChild = updatedChild => {
    updateSelf({
      subtasks: (task.subtasks || []).map(st =>
        st.id === updatedChild.id ? updatedChild : st
      ),
    });
  };

  const deleteChild = id => {
    updateSelf({
      subtasks: (task.subtasks || []).filter(st => st.id !== id),
    });
  };

  const addChild = () => {
    if (!childTitle.trim()) return;
    updateSelf({
      subtasks: [
        ...(task.subtasks || []),
        {
          id: uid(),
          title: childTitle.trim(),
          priority: "2",
          completed: false,
          progress: 0,
          comments: [],
          subtasks: [],
          tags: [],
        },
      ],
    });
    setChildTitle("");
  };

  const addComment = () => {
    if (!comment.trim()) return;
    updateSelf({ comments: [...(task.comments || []), comment.trim()] });
    setComment("");
  };

  const toggleChildOpen = id => setOpenChildren(prev => ({ ...prev, [id]: !prev[id] }));

  const addTag = () => {
    const parts = (tagInput || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const merged = Array.from(new Set([...(task.tags || []), ...parts]));
    updateSelf({ tags: merged });
    setTagInput("");
  };

  const removeTag = tag => updateSelf({ tags: (task.tags || []).filter(t => t !== tag) });

  return (
    <div className="space-y-3" style={{ marginLeft: level * 20 }}>
      <div className="p-4 rounded-xl border border-slate-600 bg-slate-800 hover:bg-slate-700 transition-all">
        <div className="flex justify-between items-start gap-4">
          <div className="flex items-start gap-3 cursor-pointer" onClick={() => setExpanded(e => !e)}>
            <input
              type="checkbox"
              checked={!!task.completed}
              onChange={e => {
                e.stopPropagation();
                updateSelf({ completed: !task.completed });
              }}
              className="mt-1 w-4 h-4 accent-blue-500"
            />
            <div>
              <div className={`font-medium ${task.completed ? "line-through text-slate-400" : "text-white"}`}>
                {task.title}
              </div>
              {task.date && <div className="text-xs text-slate-400">{task.date}</div>}
              <div className="mt-2 flex gap-2 flex-wrap">
                {(task.tags || []).map(tag => (
                  <div key={tag} className="text-xs bg-slate-700 text-slate-200 px-2 py-1 rounded flex items-center gap-2">
                    <span>{tag}</span>
                    <button onClick={e => { e.stopPropagation(); removeTag(tag); }} className="text-xs text-red-400">✕</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
            <Select value={task.priority} onValueChange={v => updateSelf({ priority: v })}>
              <SelectTrigger className="bg-slate-600 border-slate-500 text-white w-36"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-slate-800 text-white">
                {priorities.map(p => (<SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>))}
              </SelectContent>
            </Select>
            {onDelete && (
              <Button className="bg-red-600 hover:bg-red-500" onClick={() => onDelete(task.id)}>Delete</Button>
            )}
          </div>
        </div>

        <AnimatePresence>
          {expanded && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mt-4 space-y-4">
              <div>
                <div className="text-sm text-slate-300 mb-1">Progress: {task.progress || 0}%</div>
                <input type="range" min="0" max="100" value={task.progress || 0} onChange={e => updateSelf({ progress: Number(e.target.value) })} className="w-full" />
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-200">Subtasks</div>
                {(task.subtasks || []).map(st => (
                  <div key={st.id} className="bg-slate-800 border border-slate-700 rounded-lg p-2 mb-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <input type="checkbox" checked={!!st.completed} onChange={() => updateChild({ ...st, completed: !st.completed })} className="accent-blue-500" />
                        <div className={st.completed ? "line-through text-slate-400" : "text-slate-200"}>{st.title}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Select value={st.priority} onValueChange={v => updateChild({ ...st, priority: v })}>
                          <SelectTrigger className="bg-slate-600 border-slate-500 text-white w-36"><SelectValue /></SelectTrigger>
                          <SelectContent className="bg-slate-800 text-white">
                            {priorities.map(p => (<SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>))}
                          </SelectContent>
                        </Select>
                        <Button size="sm" className="bg-gray-600 hover:bg-gray-500" onClick={() => toggleChildOpen(st.id)}>{openChildren[st.id] ? "Collapse" : "Open"}</Button>
                        <Button size="sm" className="bg-red-600 hover:bg-red-500" onClick={() => deleteChild(st.id)}>Delete</Button>
                      </div>
                    </div>

                    {openChildren[st.id] && (
                      <div className="mt-3">
                        <TaskNode task={st} onChange={updateChild} onDelete={deleteChild} level={level + 2} />
                      </div>
                    )}
                  </div>
                ))}
                <div className="flex gap-2">
                  <Input placeholder="Add child task" value={childTitle} onChange={e => setChildTitle(e.target.value)} className="bg-slate-700 border-slate-600 text-white" />
                  <Button className="bg-blue-600 hover:bg-blue-500" onClick={addChild}>Add</Button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-200">Comments</div>
                {(task.comments || []).map((c, i) => (<div key={i} className="text-sm bg-slate-700 p-2 rounded text-slate-200">{c}</div>))}
                <div className="flex gap-2">
                  <Input placeholder="Add remark" value={comment} onChange={e => setComment(e.target.value)} className="bg-slate-700 border-slate-600 text-white" />
                  <Button className="bg-emerald-600 hover:bg-emerald-500" onClick={addComment}>Add</Button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-200">Tags</div>
                <div className="flex gap-2 items-center flex-wrap">
                  <Input placeholder="add tags (comma separated)" value={tagInput} onChange={e => setTagInput(e.target.value)} className="bg-slate-700 border-slate-600 text-white" />
                  <Button className="bg-indigo-600 hover:bg-indigo-500" onClick={addTag}>Add Tag</Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// -------------------- helpers for tags & traversal (unchanged) --------------------
function collectAllTags(tasks) {
  const set = new Set();
  function walk(list) {
    (list || []).forEach(t => {
      (t.tags || []).forEach(tag => set.add(tag));
      if (t.subtasks) walk(t.subtasks);
    });
  }
  walk(tasks);
  return Array.from(set).sort();
}

function collectTasksWithTag(tasks, tag) {
  const result = [];
  function walk(list, parentPath = "") {
    (list || []).forEach(t => {
      const has = (t.tags || []).includes(tag);
      if (has) result.push(t);
      if (t.subtasks) walk(t.subtasks, parentPath ? `${parentPath} > ${t.title}` : t.title);
    });
  }
  walk(tasks);
  return result;
}

// -------------------- Main TodoApp (storage switched to Supabase) --------------------
export default function TodoApp() {
  const [profiles, setProfiles] = useState(["Default"]);
  const [activeProfile, setActiveProfile] = useState(() => {
    if (typeof window !== "undefined") return localStorage.getItem("activeProfile") || "Default";
    return "Default";
  });
  const [newProfileName, setNewProfileName] = useState('');
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [priority, setPriority] = useState("2");
  const [tagInput, setTagInput] = useState("");
  const [activeTab, setActiveTab] = useState("calendar");
  const [selectedDate, setSelectedDate] = useState(null);
  const [findQuery, setFindQuery] = useState("");
  const [findPriority, setFindPriority] = useState("all");
  const [findTag, setFindTag] = useState("all");
  const [findCompleted, setFindCompleted] = useState("all");
  const [findDateFrom, setFindDateFrom] = useState("");
  const [findDateTo, setFindDateTo] = useState("");
  const [currentMonth, setCurrentMonth] = useState(new Date());

  // Load profiles once from DB on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      const list = await loadProfilesFromDB();
      if (!mounted) return;
      setProfiles(list);
      // use previously selected profile if still present
      if (typeof window !== "undefined") {
        const saved = localStorage.getItem("activeProfile");
        if (saved && list.includes(saved)) setActiveProfile(saved);
        else setActiveProfile(list[0] || "Default");
      } else {
        setActiveProfile(list[0] || "Default");
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Whenever activeProfile changes, load tasks for it from DB
  useEffect(() => {
    if (!activeProfile) return;
    let mounted = true;
    (async () => {
      const loaded = await loadTasksFromDB(activeProfile);
      if (!mounted) return;
      setTasks(Array.isArray(loaded) ? loaded : []);
    })();
    // also persist activeProfile locally for quick UI restore
    if (typeof window !== "undefined") localStorage.setItem("activeProfile", activeProfile);
    return () => { mounted = false; };
  }, [activeProfile]);

  // Save tasks to DB whenever tasks change
useEffect(() => {
  if (!activeProfile) return;
  (async () => {
    try {
      await saveTasksToDB(activeProfile, tasks);
      // remove orphaned rows that the user deleted locally
      await cleanupDeletedTasks(activeProfile, tasks);
    } catch (e) {
      console.error("Error saving tasks & cleaning up:", e);
    }
  })();
}, [tasks, activeProfile]);


  // Save profiles to DB whenever profiles change
  useEffect(() => {
    (async () => {
      await saveProfilesToDB(profiles);
    })();
  }, [profiles]);

  const today = toISODate(new Date());

  const addProfile = () => {
    const name = newProfileName.trim();
    if (!name || profiles.includes(name)) return;
    setProfiles(p => [...p, name]);
    setActiveProfile(name);
    setNewProfileName('');
  };

  const deleteProfile = name => {
    if (profiles.length === 1) return;
    const updated = profiles.filter(p => p !== name);
    setProfiles(updated);
    if (activeProfile === name) setActiveProfile(updated[0]);
    // also remove tasks for that profile from DB
    (async () => {
      if (!supabase) return;
      try {
        await supabase.from("tasks").delete().eq("profile", name);
        await supabase.from("profiles").delete().eq("name", name);
      } catch (e) {
        console.error("deleteProfile error", e);
      }
    })();
  };

  const addTask = () => {
    if (!title.trim() || !date) return;
    const tags = (tagInput || "").split(",").map(s => s.trim()).filter(Boolean);
    const newTask = { id: uid(), title: title.trim(), date, priority, completed: false, progress: 0, comments: [], subtasks: [], tags };
    setTasks(prev => [...prev, newTask]);
    setTitle("");
    setDate("");
    setPriority("2");
    setTagInput("");
  };

  const updateTask = updated => setTasks(prev => prev.map(t => (t.id === updated.id ? updated : t)));
  const deleteTask = id => setTasks(prev => prev.filter(t => t.id !== id));

  const filteredTasks = useMemo(() => {
    let result = Array.isArray(tasks) ? tasks : [];
    if (selectedDate) result = result.filter(t => t.date === selectedDate);
    return [...result].sort((a, b) => Number(b.priority) - Number(a.priority));
  }, [tasks, selectedDate]);

  const tasksByDate = useMemo(() => {
    const map = {};
    tasks.forEach(t => {
      if (!map[t.date]) map[t.date] = [];
      map[t.date].push(t);
    });
    return map;
  }, [tasks]);

  const monthStart = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
  const monthEnd = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);
  const startDay = monthStart.getDay();
  const daysInMonth = monthEnd.getDate();

  const calendarDays = [];
  for (let i = 0; i < startDay; i++) calendarDays.push(null);
  for (let d = 1; d <= daysInMonth; d++) calendarDays.push(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), d));

  const analyticsData = useMemo(() => {
    const total = tasks.length;
    const completed = tasks.filter(t => t.completed).length;
    const avgProgress = total ? Math.round(tasks.reduce((a, b) => a + (b.progress || 0), 0) / total) : 0;
    const byPriority = priorities.map(p => ({ name: p.label, value: tasks.filter(t => t.priority === p.value).length }));
    const byDate = Object.keys(tasksByDate).map(date => ({ date, count: tasksByDate[date].length }));
    const overdue = tasks.filter(t => !t.completed && t.date && t.date < today).length;
    const highPriority = tasks.filter(t => t.priority === "4").length;
    const mostProductive = byDate.slice().sort((a,b)=>b.count-a.count)[0]?.date || null;
    const leastProductive = byDate.slice().sort((a,b)=>a.count-b.count)[0]?.date || null;
    const tags = collectAllTags(tasks);
    const byTag = tags.map(tag => {
      const tagged = collectTasksWithTag(tasks, tag);
      const count = tagged.length;
      const completedCount = tagged.filter(t => t.completed).length;
      const avgTagProgress = count ? Math.round(tagged.reduce((a,b)=>a+(b.progress||0),0)/count) : 0;
      return { tag, count, completedCount, avgTagProgress };
    });
    return { total, completed, avgProgress, byPriority, byDate, overdue, highPriority, mostProductive, leastProductive, byTag };
  }, [tasks, tasksByDate, today]);

  const tabClass = active => `px-5 py-2 rounded-xl text-sm font-semibold transition-all duration-200 ${active ? "bg-blue-500 text-white shadow-lg scale-105" : "bg-gray-700 text-gray-200 hover:bg-gray-600"}`;

  const allTags = useMemo(() => collectAllTags(tasks), [tasks]);

  const flattenedTasks = useMemo(() => {
    const out = [];
    function walk(list) {
      (list || []).forEach(t => {
        out.push(t);
        if (t.subtasks) walk(t.subtasks);
      });
    }
    walk(tasks);
    return out;
  }, [tasks]);

  const findResults = useMemo(() => {
    const q = (findQuery || "").toLowerCase().trim();
    return flattenedTasks.filter(t => {
      if (findPriority !== "all" && t.priority !== findPriority) return false;
      if (findTag !== "all" && !(t.tags || []).includes(findTag)) return false;
      if (findCompleted === "completed" && !t.completed) return false;
      if (findCompleted === "active" && t.completed) return false;
      if (findDateFrom && t.date && t.date < findDateFrom) return false;
      if (findDateTo && t.date && t.date > findDateTo) return false;
      if (q) {
        return (t.title || "").toLowerCase().includes(q) || (t.comments || []).some(c => c.toLowerCase().includes(q));
      }
      return true;
    });
  }, [flattenedTasks, findQuery, findPriority, findTag, findCompleted, findDateFrom, findDateTo]);

  const byDateDetailed = useMemo(() => {
    const map = {};
    (analyticsData.byDate || []).forEach(d => {
      const tasksForDate = tasksByDate[d.date] || [];
      const completedCount = tasksForDate.filter(t => t.completed).length;
      const avg = tasksForDate.length ? Math.round(tasksForDate.reduce((a,b)=>a+(b.progress||0),0)/tasksForDate.length) : 0;
      map[d.date] = { date: d.date, count: d.count, completedCount, avgProgress: avg, completedPct: tasksForDate.length ? Math.round((completedCount / tasksForDate.length) * 100) : 0 };
    });
    return Object.values(map).sort((a,b) => a.date.localeCompare(b.date));
  }, [analyticsData.byDate, tasksByDate]);

  const byTagDetailed = useMemo(() => (analyticsData.byTag || []).map(t => ({ ...t, remaining: t.count - t.completedCount })), [analyticsData.byTag]);

  const priorityWithPct = useMemo(() => {
    const total = analyticsData.byPriority.reduce((s,p)=>s+p.value,0) || 1;
    return analyticsData.byPriority.map((p,i) => ({ ...p, pct: Math.round((p.value/total)*100), color: Object.values(priorityColor)[i] }));
  }, [analyticsData.byPriority]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-slate-100 p-8">
      <div className="max-w-7xl mx-auto space-y-8">
        <h1 className="text-4xl font-bold text-white">Productivity Dashboard</h1>

        <Card className="bg-slate-800 border border-slate-700 rounded-2xl">
          <CardContent className="p-6 flex gap-3 flex-wrap items-center">
            <Select value={activeProfile} onValueChange={setActiveProfile}>
              <SelectTrigger className="bg-slate-700 border-slate-600 text-white w-48"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-slate-800 text-white">
                {profiles.map(p => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Input
              placeholder="New profile name"
              value={newProfileName}
              onChange={e => setNewProfileName(e.target.value)}
              className="bg-slate-700 border-slate-600 text-white w-48"
            />
            <Button className="bg-blue-600 hover:bg-blue-500" onClick={addProfile}>Add Profile</Button>

            {profiles.length > 1 && (
              <Button className="bg-red-600 hover:bg-red-500" onClick={() => deleteProfile(activeProfile)}>Delete Current Profile</Button>
            )}
          </CardContent>
        </Card>

        <Card className="bg-slate-800 border border-slate-700 rounded-2xl">
          <CardContent className="p-6 flex gap-3 flex-wrap">
            <button className={tabClass(activeTab === "tasks")} onClick={() => setActiveTab("tasks")}>Tasks</button>
            <button className={tabClass(activeTab === "calendar")} onClick={() => setActiveTab("calendar")}>Calendar</button>
            <button className={tabClass(activeTab === "tags")} onClick={() => setActiveTab("tags")}>Tags</button>
            <button className={tabClass(activeTab === "analytics")} onClick={() => setActiveTab("analytics")}>Analytics</button>
            <button className={tabClass(activeTab === "find")} onClick={() => setActiveTab("find")}>Find</button>
          </CardContent>
        </Card>

        {activeTab === "tasks" && (
          <Card className="bg-slate-800 border border-slate-700 rounded-2xl">
            <CardContent className="p-6 space-y-4">
              <div className="flex gap-3 flex-wrap">
                <Input placeholder="Task title" value={title} onChange={e => setTitle(e.target.value)} className="bg-slate-700 border-slate-600 text-white" />
                <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="bg-slate-700 border-slate-600 text-white" />
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white w-40"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-slate-800 text-white">
                    {priorities.map(p => (<SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>))}
                  </SelectContent>
                </Select>
                <Input placeholder="tags (comma separated)" value={tagInput} onChange={e => setTagInput(e.target.value)} className="bg-slate-700 border-slate-600 text-white" />
                <Button className="bg-blue-600 hover:bg-blue-500" onClick={addTask}>Add</Button>
              </div>

              <div className="space-y-3">
                {filteredTasks.map(task => (
                  <TaskNode key={task.id} task={task} onChange={updateTask} onDelete={deleteTask} />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === "calendar" && (
          <Card className="bg-slate-800 border border-slate-700 rounded-2xl">
            <CardContent className="p-6 space-y-6">
              <div className="flex justify-between items-center">
                <Button onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))}>Previous</Button>
                <div className="text-xl font-semibold">{currentMonth.toLocaleString("default", { month: "long" })} {currentMonth.getFullYear()}</div>
                <Button onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))}>Next</Button>
              </div>

              <div className="grid grid-cols-7 gap-2 text-center text-sm font-semibold text-slate-400">
                {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => <div key={d}>{d}</div>)}
              </div>

              <div className="grid grid-cols-7 gap-2">
                {calendarDays.map((day, idx) => {
                  if (!day) return <div key={idx}></div>;
                  const iso = toISODate(day);
                  const dayTasks = tasksByDate[iso] || [];
                  const avg = dayTasks.length ? dayTasks.reduce((a,b)=>a+(b.progress||0),0)/dayTasks.length : 0;
                  const bg = avg === 100 ? "bg-green-600" : avg > 0 ? "bg-yellow-600" : dayTasks.length ? "bg-red-600" : "bg-slate-700";
                  return (
                    <div key={iso} onClick={() => { setSelectedDate(iso); setActiveTab("tasks"); }} className={`p-3 rounded-xl cursor-pointer ${bg} hover:opacity-80`}>
                      {day.getDate()}
                      {dayTasks.length > 0 && <div className="text-xs mt-1">{dayTasks.length} tasks</div>}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === "tags" && (
          <Card className="bg-slate-800 border border-slate-700 rounded-2xl">
            <CardContent className="p-6 space-y-4">
              <div className="text-lg font-semibold">Tags</div>
              <div className="grid md:grid-cols-3 gap-4">
                {allTags.length === 0 && <div className="text-slate-400">No tags yet</div>}
                {allTags.map(tag => (
                  <div key={tag} className="bg-slate-700 p-3 rounded">
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-slate-100">{tag}</div>
                      <div className="text-sm text-slate-300">{collectTasksWithTag(tasks, tag).length} tasks</div>
                    </div>
                    <div className="mt-2 space-y-2">
                      {collectTasksWithTag(tasks, tag).map(t => (
                        <details key={t.id} className="bg-slate-800 p-2 rounded">
                          <summary className="cursor-pointer text-slate-200">{t.title} <span className="text-xs text-slate-400">{t.date}</span></summary>
                          <div className="mt-2 text-sm text-slate-300">Priority: {priorities.find(p=>p.value===t.priority)?.label || t.priority}</div>
                          <div className="text-sm text-slate-300">Progress: {t.progress || 0}%</div>
                        </details>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === "find" && (
          <Card className="bg-slate-800 border border-slate-700 rounded-2xl">
            <CardContent className="p-6 space-y-4">
              <div className="flex gap-3 items-center flex-wrap">
                <Input placeholder="Search tasks" value={findQuery} onChange={e => setFindQuery(e.target.value)} className="bg-slate-700 border-slate-600 text-white w-72" />
                <Select value={findPriority} onValueChange={setFindPriority}>
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white w-40"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-slate-800 text-white">
                    <SelectItem value="all">All priorities</SelectItem>
                    {priorities.map(p => (<SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>))}
                  </SelectContent>
                </Select>
                <Select value={findTag} onValueChange={setFindTag}>
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white w-40"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-slate-800 text-white">
                    <SelectItem value="all">All tags</SelectItem>
                    {allTags.map(tag => (<SelectItem key={tag} value={tag}>{tag}</SelectItem>))}
                  </SelectContent>
                </Select>
                <Select value={findCompleted} onValueChange={setFindCompleted}>
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white w-36"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-slate-800 text-white">
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                  </SelectContent>
                </Select>
                <Input type="date" value={findDateFrom} onChange={e=>setFindDateFrom(e.target.value)} className="bg-slate-700 border-slate-600 text-white" />
                <Input type="date" value={findDateTo} onChange={e=>setFindDateTo(e.target.value)} className="bg-slate-700 border-slate-600 text-white" />
                <Button className="bg-blue-600 hover:bg-blue-500" onClick={() => setActiveTab('find')}>Search</Button>
              </div>

              <div className="space-y-3">
                {findResults.length === 0 && <div className="text-slate-400">No results</div>}
                {findResults.map(t => (
                  <details key={t.id} className="bg-slate-800 p-3 rounded">
                    <summary className="cursor-pointer text-slate-200">{t.title} <span className="text-xs text-slate-400">{t.date}</span></summary>
                    <div className="mt-2 text-sm text-slate-300">Priority: {priorities.find(p=>p.value===t.priority)?.label || t.priority}</div>
                    <div className="text-sm text-slate-300">Progress: {t.progress || 0}%</div>
                    <div className="text-sm text-slate-300">Tags: {(t.tags||[]).join(', ')}</div>
                  </details>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === "analytics" && (
          <Card className="bg-slate-800 border border-slate-700 rounded-2xl">
            <CardContent className="p-6 space-y-6">
              <div className="grid grid-cols-4 gap-6 text-center">
                <div className="bg-slate-700 p-4 rounded-lg">
                  <div className="text-3xl font-bold">{analyticsData.total}</div>
                  <div className="text-slate-400">Total Tasks</div>
                </div>
                <div className="bg-slate-700 p-4 rounded-lg">
                  <div className="text-3xl font-bold">{analyticsData.completed}</div>
                  <div className="text-slate-400">Completed</div>
                </div>
                <div className="bg-slate-700 p-4 rounded-lg">
                  <div className="text-3xl font-bold">{analyticsData.avgProgress}%</div>
                  <div className="text-slate-400">Average Progress</div>
                </div>
                <div className="bg-slate-700 p-4 rounded-lg">
                  <div className="text-3xl font-bold">{analyticsData.overdue}</div>
                  <div className="text-slate-400">Overdue</div>
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                <div className="bg-slate-700 p-4 rounded-lg">
                  <div className="text-lg font-semibold mb-2">Tasks Over Time</div>
                  <div style={{ height: 420 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={byDateDetailed} margin={{ top: 10, right: 30, left: 0, bottom: 40 }}>
                        <CartesianGrid stroke="#334155" />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} angle={-45} textAnchor="end" height={60} />
                        <YAxis yAxisId="left" label={{ value: 'Tasks', angle: -90, position: 'insideLeft' }} />
                        <YAxis yAxisId="right" orientation="right" label={{ value: '% Completed', angle: -90, position: 'insideRight' }} />
                        <Tooltip />
                        <BarChart data={byDateDetailed}>
                          <Bar dataKey="count" fill="#3b82f6" />
                        </BarChart>
                        <Line type="monotone" dataKey="completedPct" stroke="#22c55e" strokeWidth={3} dot />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-3 text-sm text-slate-400">Blue = number of tasks that day. Green line = percent completed that day.</div>
                </div>

                <div className="bg-slate-700 p-4 rounded-lg">
                  <div className="text-lg font-semibold mb-2">Tag Insights (Completed vs Remaining)</div>
                  <div style={{ height: 420 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={byTagDetailed} margin={{ top: 10, right: 20, left: 0, bottom: 80 }}>
                        <CartesianGrid stroke="#334155" />
                        <XAxis dataKey="tag" tick={{ fontSize: 12 }} angle={-45} textAnchor="end" height={70} />
                        <YAxis />
                        <Tooltip formatter={(value, name) => [`${value}`, name]} />
                        <Bar dataKey="completedCount" stackId="a" fill="#16a34a" name="Completed" />
                        <Bar dataKey="remaining" stackId="a" fill="#f59e0b" name="Remaining" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-3 text-sm text-slate-400">Stacked bars show how much work per tag is done vs remaining.</div>
                </div>
              </div>

              <div className="bg-slate-700 p-4 rounded-lg">
                <div className="text-lg font-semibold mb-2">Priority Breakdown</div>
                <div style={{ height: 360 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={priorityWithPct} dataKey="value" nameKey="name" outerRadius={120} innerRadius={60} labelLine={false} label={entry => `${entry.name.split(' ')[1] || entry.name} (${entry.pct}%)`}>
                        {priorityWithPct.map((entry, index) => (
                          <Cell key={index} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => `${value} tasks`} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
                  {priorityWithPct.map((p, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span style={{ width: 12, height: 12, background: p.color, display: 'inline-block', borderRadius: 3 }} />
                      <div className="flex-1 text-slate-200">{p.name}</div>
                      <div className="text-slate-400">{p.value} ({p.pct}%)</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                <div className="bg-slate-700 p-4 rounded-lg">
                  <div className="text-lg font-semibold mb-2">Top Upcoming Tasks</div>
                  <div className="space-y-2 max-h-44 overflow-y-auto">
                    {tasks.filter(t => !t.completed && t.date && t.date >= today).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,8).map(t => (
                      <div key={t.id} className="flex items-center justify-between bg-slate-800 p-2 rounded">
                        <div>
                          <div className="text-sm text-slate-200">{t.title}</div>
                          <div className="text-xs text-slate-400">{t.date}</div>
                        </div>
                        <div style={{ width: 10, height: 10, background: priorityColor[t.priority] || '#64748b', borderRadius: 4 }} />
                      </div>
                    ))}
                    {tasks.filter(t => !t.completed && t.date && t.date >= today).length === 0 && <div className="text-sm text-slate-400">No upcoming tasks</div>}
                  </div>
                </div>

                <div className="bg-slate-700 p-4 rounded-lg">
                  <div className="text-lg font-semibold mb-2">Key Metrics</div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="p-2 bg-slate-800 rounded">Completion Rate<div className="font-bold">{analyticsData.total ? Math.round((analyticsData.completed/analyticsData.total)*100) : 0}%</div></div>
                    <div className="p-2 bg-slate-800 rounded">High Priority<div className="font-bold">{analyticsData.highPriority}</div></div>
                    <div className="p-2 bg-slate-800 rounded">Overdue<div className="font-bold text-red-400">{analyticsData.overdue}</div></div>
                    <div className="p-2 bg-slate-800 rounded">Average Progress<div className="font-bold">{analyticsData.avgProgress}%</div></div>
                    <div className="p-2 bg-slate-800 rounded">Distinct Tags<div className="font-bold">{analyticsData.byTag.length}</div></div>
                    <div className="p-2 bg-slate-800 rounded">Top Tag Avg Progress<div className="font-bold">{analyticsData.byTag.slice().sort((a,b)=>b.avgTagProgress-a.avgTagProgress)[0]?.avgTagProgress || 0}%</div></div>
                  </div>
                </div>
              </div>

            </CardContent>
          </Card>
        )}

      </div>
    </div>
  );
}

