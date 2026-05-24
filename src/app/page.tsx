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

const priorityIcon: Record<string, string> = {
  "4": "🚨",
  "3": "⚠️",
  "2": "📌",
  "1": "🟢",
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
    await supabase.from("profiles").insert([{ name: "Default" }]);
    return ["Default"];
  }
  return data.map((r: any) => r.name);
}

async function saveProfilesToDB(profiles: string[]) {
  if (!supabase) return;
  try {
    const rows = profiles.map(name => ({ name }));
    await supabase.from("profiles").upsert(rows, { onConflict: "name" });
  } catch (e) {
    console.error("saveProfilesToDB error", e);
  }
}

async function loadTasksFromDB(profile: string): Promise<any[] | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from("tasks").select("id, content").eq("profile", profile);
    if (error) {
      console.error("loadTasksFromDB error:", error);
      return null;
    }
    return (data || []).map((r: any) => (typeof r.content === "string" ? safeParse(r.content) || null : r.content)).filter(Boolean);
  } catch (e) {
    console.error("loadTasksFromDB exception:", e);
    return null;
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
    await supabase.from("tasks").upsert(rows, { onConflict: "id" });
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

// -------------------- Recurrence Engine --------------------
function getNextOccurrence(dateStr: string, recurrence: any): string | null {
  if (!recurrence || recurrence.frequency === 'none') return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;

  const interval = recurrence.interval || 1;

  if (recurrence.frequency === 'daily') {
    d.setDate(d.getDate() + interval);
  } else if (recurrence.frequency === 'weekly') {
    if (recurrence.daysOfWeek && recurrence.daysOfWeek.length > 0) {
      const currentDay = d.getDay();
      const sortedDays = [...recurrence.daysOfWeek].sort((a, b) => a - b);
      const nextDay = sortedDays.find(day => day > currentDay);
      if (nextDay !== undefined) {
        d.setDate(d.getDate() + (nextDay - currentDay));
      } else {
        const daysUntilNext = 7 - currentDay + sortedDays[0];
        const weekOffset = (interval - 1) * 7;
        d.setDate(d.getDate() + daysUntilNext + weekOffset);
      }
    } else {
      d.setDate(d.getDate() + 7 * interval);
    }
  } else if (recurrence.frequency === 'monthly') {
    d.setMonth(d.getMonth() + interval);
  } else if (recurrence.frequency === 'yearly') {
    d.setFullYear(d.getFullYear() + interval);
  } else if (recurrence.frequency === 'custom_dates') {
    if (recurrence.specificDates && recurrence.specificDates.length > 0) {
      const next = recurrence.specificDates.find((sd: string) => sd > dateStr);
      if (next) return next;
    }
    return null;
  }

  const iso = toISODate(d);
  if (recurrence.endDate && iso > recurrence.endDate) return null;
  return iso;
}

// -------------------- TaskNode component --------------------
function TaskNode({ task, onChange, onDelete, level = 0 }: { task: any; onChange: (t: any) => void; onDelete?: (id: string) => void; level?: number; }) {
  const [expanded, setExpanded] = useState(false);
  const [childTitle, setChildTitle] = useState("");
  const [comment, setComment] = useState("");
  const [openChildren, setOpenChildren] = useState<Record<string, boolean>>({});
  const [tagInput, setTagInput] = useState("");
  
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [tempTitle, setTempTitle] = useState(task.title);

  const updateSelf = (updates: any) => onChange({ ...task, ...updates });

  const updateChild = (updatedChild: any) => {
    updateSelf({ subtasks: (task.subtasks || []).map((st: any) => st.id === updatedChild.id ? updatedChild : st ) });
  };

  const deleteChild = (id: any) => {
    updateSelf({ subtasks: (task.subtasks || []).filter((st: any) => st.id !== id) });
  };

  const addChild = () => {
    if (!childTitle.trim()) return;
    updateSelf({
      subtasks: [...(task.subtasks || []), { id: uid(), title: childTitle.trim(), priority: "2", completed: false, progress: 0, comments: [], subtasks: [], tags: [] }],
    });
    setChildTitle("");
  };

  const addComment = () => {
    if (!comment.trim()) return;
    updateSelf({ comments: [...(task.comments || []), comment.trim()] });
    setComment("");
  };

  const toggleChildOpen = (id: any) => setOpenChildren(prev => ({ ...prev, [id]: !prev[id] }));

  const addTag = () => {
    const parts = (tagInput || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    updateSelf({ tags: Array.from(new Set([...(task.tags || []), ...parts])) });
    setTagInput("");
  };

  const removeTag = (tag: any) => updateSelf({ tags: (task.tags || []).filter((t: any) => t !== tag) });

  const saveTitle = () => {
    setIsEditingTitle(false);
    if (tempTitle.trim() && tempTitle !== task.title) {
        updateSelf({ title: tempTitle.trim() });
    } else {
        setTempTitle(task.title);
    }
  };

  return (
    <div className="space-y-3" style={{ marginLeft: level * 20 }}>
      <div className="p-4 rounded-xl border border-slate-600 bg-slate-800 hover:bg-slate-700 transition-all relative overflow-hidden">
        <div className="flex justify-between items-start gap-4">
          <div className="flex items-start gap-3 cursor-pointer flex-1" onClick={() => setExpanded(e => !e)}>
            <input
              type="checkbox"
              checked={!!task.completed}
              onChange={e => { e.stopPropagation(); updateSelf({ completed: !task.completed }); }}
              className="mt-1 w-4 h-4 accent-blue-500 flex-shrink-0"
            />
            <div className="flex-1 min-w-0">
              <div className={`font-medium break-words ${task.completed ? "line-through text-slate-400" : "text-white"}`}>
                
                {isEditingTitle ? (
                    <input 
                        type="text"
                        autoFocus
                        value={tempTitle}
                        onChange={(e) => setTempTitle(e.target.value)}
                        onBlur={saveTitle}
                        onKeyDown={(e) => e.key === 'Enter' && saveTitle()}
                        onClick={(e) => e.stopPropagation()}
                        className="bg-slate-900 border border-blue-500 text-white px-2 py-0.5 rounded outline-none w-full max-w-sm"
                    />
                ) : (
                    <span 
                        onDoubleClick={(e) => { e.stopPropagation(); setIsEditingTitle(true); }}
                        title="Double click to edit"
                    >
                        {task.title}
                    </span>
                )}

                {task.recurrence && task.recurrence.frequency !== 'none' && (
                  <span className="ml-2 text-xs text-blue-400 bg-blue-900/40 px-1.5 py-0.5 rounded inline-block translate-y-[-2px]" title="Recurring task">
                    🔁 {task.recurrence.frequency}
                  </span>
                )}
              </div>
              {task.date && <div className="text-xs text-slate-400">{task.date}</div>}
              
              <div className="mt-2 flex gap-2 flex-wrap">
                {(task.tags || []).map((tag: string) => (
                  <div key={tag} className="text-xs bg-slate-700 text-slate-200 px-2 py-1 rounded flex items-center gap-2">
                    <span className="truncate max-w-[100px]">{tag}</span>
                    <button onClick={e => { e.stopPropagation(); removeTag(tag); }} className="text-xs text-red-400 hover:text-red-300">✕</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
            <Select value={task.priority} onValueChange={v => updateSelf({ priority: v })}>
              <SelectTrigger className="bg-slate-600 border-slate-500 text-white w-28 md:w-36 h-8 text-xs md:text-sm"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-slate-800 text-white">
                {priorities.map(p => (<SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>))}
              </SelectContent>
            </Select>
            {onDelete && (
              <Button size="sm" variant="ghost" className="text-slate-400 hover:text-red-400 hover:bg-red-900/20 px-2 h-8" onClick={() => onDelete(task.id)}>🗑️</Button>
            )}
          </div>
        </div>

        {(task.progress || 0) > 0 && !task.completed && (
            <div className="absolute bottom-0 left-0 h-1 bg-slate-600 w-full opacity-50">
                <div className="h-full bg-blue-500" style={{ width: `${task.progress}%` }} />
            </div>
        )}

        <AnimatePresence>
          {expanded && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mt-4 space-y-4 pb-2">
              <div>
                <div className="text-sm text-slate-300 mb-1 flex justify-between">
                    <span>Progress</span>
                    <span className="font-mono text-blue-400">{task.progress || 0}%</span>
                </div>
                <input type="range" min="0" max="100" value={task.progress || 0} onChange={e => updateSelf({ progress: Number(e.target.value) })} className="w-full accent-blue-500" />
              </div>

              {/* Subtasks */}
              <div className="space-y-2 bg-slate-900/30 p-3 rounded-lg border border-slate-700/50">
                <div className="text-sm font-semibold text-slate-200">Subtasks</div>
                {(task.subtasks || []).map((st: any) => (
                  <div key={st.id} className="bg-slate-800 border border-slate-700 rounded-lg p-2 mb-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <input type="checkbox" checked={!!st.completed} onChange={() => updateChild({ ...st, completed: !st.completed })} className="accent-blue-500 flex-shrink-0" />
                        <div className={`truncate text-sm ${st.completed ? "line-through text-slate-400" : "text-slate-200"}`}>{st.title}</div>
                      </div>
                      <div className="flex items-center gap-1 md:gap-2">
                        <Select value={st.priority} onValueChange={v => updateChild({ ...st, priority: v })}>
                          <SelectTrigger className="bg-slate-600 border-slate-500 text-white w-20 md:w-28 h-7 text-xs px-1 md:px-2"><SelectValue /></SelectTrigger>
                          <SelectContent className="bg-slate-800 text-white">
                            {priorities.map(p => (<SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>))}
                          </SelectContent>
                        </Select>
                        <Button size="sm" variant="ghost" className="h-7 text-xs px-1 md:px-2 bg-gray-700 hover:bg-gray-600" onClick={() => toggleChildOpen(st.id)}>{openChildren[st.id] ? "Hide" : "Open"}</Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs px-1 md:px-2 text-red-400 hover:text-red-300 hover:bg-red-900/30" onClick={() => deleteChild(st.id)}>✕</Button>
                      </div>
                    </div>
                    {openChildren[st.id] && (
                      <div className="mt-3"><TaskNode task={st} onChange={updateChild} onDelete={deleteChild} level={level + 2} /></div>
                    )}
                  </div>
                ))}
                <div className="flex gap-2">
                  <Input placeholder="Add subtask" value={childTitle} onChange={e => setChildTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addChild()} className="bg-slate-700 border-slate-600 text-white h-8 text-sm flex-1" />
                  <Button size="sm" className="bg-blue-600 hover:bg-blue-500 h-8" onClick={addChild}>Add</Button>
                </div>
              </div>

              {/* Comments & Tags Grid */}
              <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="text-sm font-semibold text-slate-200">Comments</div>
                    <div className="max-h-32 overflow-y-auto space-y-1 pr-1">
                        {(task.comments || []).map((c: string, i: number) => (<div key={i} className="text-sm bg-slate-700/50 p-2 rounded text-slate-200 break-words">{c}</div>))}
                    </div>
                    <div className="flex gap-2">
                      <Input placeholder="Add remark" value={comment} onChange={e => setComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addComment()} className="bg-slate-700 border-slate-600 text-white h-8 text-sm flex-1" />
                      <Button size="sm" className="bg-emerald-600 hover:bg-emerald-500 h-8" onClick={addComment}>Add</Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-sm font-semibold text-slate-200">Tags</div>
                    <div className="flex gap-2 items-center">
                      <Input placeholder="tags (comma separated)" value={tagInput} onChange={e => setTagInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTag()} className="bg-slate-700 border-slate-600 text-white h-8 text-sm flex-1" />
                      <Button size="sm" className="bg-indigo-600 hover:bg-indigo-500 h-8" onClick={addTag}>Add</Button>
                    </div>
                  </div>
              </div>

            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// -------------------- helpers for tags & traversal --------------------
function collectAllTags(tasks: any[]): string[] {
  const set = new Set<string>();
  function walk(list: any[]) {
    (list || []).forEach((t: any) => {
      (t.tags || []).forEach((tag: string) => set.add(tag));
      if (t.subtasks) walk(t.subtasks);
    });
  }
  walk(tasks);
  return Array.from(set).sort();
}

function collectTasksWithTag(tasks: any[], tag: string): any[] {
  const result: any[] = [];
  function walk(list: any[], parentPath: string = "") {
    (list || []).forEach((t: any) => {
      const has = (t.tags || []).includes(tag);
      if (has) result.push(t);
      if (t.subtasks) walk(t.subtasks, parentPath ? `${parentPath} > ${t.title}` : t.title);
    });
  }
  walk(tasks);
  return result;
}

// -------------------- Main TodoApp --------------------
export default function TodoApp() {
  const [profiles, setProfiles] = useState(["Default"]);
  const [activeProfile, setActiveProfile] = useState(() => {
    if (typeof window !== "undefined") return localStorage.getItem("activeProfile") || "Default";
    return "Default";
  });
  const [newProfileName, setNewProfileName] = useState('');
  const [tasks, setTasks] = useState<any[]>([]);
  
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [priority, setPriority] = useState("2");
  const [tagInput, setTagInput] = useState("");
  const [hideCompleted, setHideCompleted] = useState(false);

  const [tasksLoaded, setTasksLoaded] = useState(false);
  
  // Recurrence state
  const [isRecurring, setIsRecurring] = useState(false);
  const [recFreq, setRecFreq] = useState("daily");
  const [recInterval, setRecInterval] = useState(1);
  const [recDays, setRecDays] = useState<number[]>([]);
  const [recEndDate, setRecEndDate] = useState("");
  const [recDatesInput, setRecDatesInput] = useState("");

  const [activeTab, setActiveTab] = useState("calendar");
  
  const [expandedDates, setExpandedDates] = useState<Record<string, boolean>>(() => ({
    [toISODate(new Date())]: true,
    "⚠️ Overdue": true
  }));

  const [findQuery, setFindQuery] = useState("");
  const [findPriority, setFindPriority] = useState("all");
  const [findTag, setFindTag] = useState("all");
  const [findCompleted, setFindCompleted] = useState("all");
  const [findDateFrom, setFindDateFrom] = useState("");
  const [findDateTo, setFindDateTo] = useState("");
  const [currentMonth, setCurrentMonth] = useState(new Date());

  useEffect(() => {
    let mounted = true;
    (async () => {
      const list = await loadProfilesFromDB();
      if (!mounted) return;
      setProfiles(list);
      if (typeof window !== "undefined") {
        const saved = localStorage.getItem("activeProfile");
        if (saved && list.includes(saved)) setActiveProfile(saved);
        else setActiveProfile(list[0] || "Default");
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!activeProfile) return;
    let mounted = true;
    setTasksLoaded(false); 
    (async () => {
      const loaded = await loadTasksFromDB(activeProfile);
      if (!mounted) return;
      
      if (loaded !== null) {
        setTasks(Array.isArray(loaded) ? loaded : []);
        setTasksLoaded(true); 
      } else {
        console.error("Database connection failed. Sync locked to prevent data loss.");
      }
    })();
    if (typeof window !== "undefined") localStorage.setItem("activeProfile", activeProfile);
    return () => { mounted = false; };
  }, [activeProfile]);

  useEffect(() => {
    if (!activeProfile || !tasksLoaded) return; 
    (async () => {
      try {
        await saveTasksToDB(activeProfile, tasks);
        await cleanupDeletedTasks(activeProfile, tasks);
      } catch (e) {
        console.error("Error saving tasks:", e);
      }
    })();
  }, [tasks, activeProfile, tasksLoaded]);

  useEffect(() => {
    (async () => { await saveProfilesToDB(profiles); })();
  }, [profiles]);

  const today = toISODate(new Date());

  const addProfile = () => {
    const name = newProfileName.trim();
    if (!name || profiles.includes(name)) return;
    setProfiles(p => [...p, name]);
    setActiveProfile(name);
    setNewProfileName('');
  };

  const deleteProfile = (name: string) => {
    if (profiles.length === 1) return;
    const updated = profiles.filter(p => p !== name);
    setProfiles(updated);
    if (activeProfile === name) setActiveProfile(updated[0]);
    (async () => {
      if (!supabase) return;
      try {
        await supabase.from("tasks").delete().eq("profile", name);
        await supabase.from("profiles").delete().eq("name", name);
      } catch (e) {}
    })();
  };

  const addTask = () => {
    if (!title.trim() || !date) return;
    const tags = (tagInput || "").split(",").map(s => s.trim()).filter(Boolean);
    
    let recurrence = undefined;
    if (isRecurring && recFreq !== "none") {
      recurrence = {
        frequency: recFreq,
        interval: Number(recInterval) || 1,
        daysOfWeek: recFreq === 'weekly' ? recDays : [],
        endDate: recEndDate || undefined,
        specificDates: recFreq === 'custom_dates' 
          ? recDatesInput.split(',').map(s=>s.trim()).filter(Boolean).sort()
          : []
      };
    }

    const newTask = { 
      id: uid(), title: title.trim(), date, priority, completed: false, progress: 0, 
      comments: [], subtasks: [], tags, recurrence 
    };
    
    setTasks(prev => [...prev, newTask]);
    setTitle(""); setDate(toISODate(new Date())); setPriority("2"); setTagInput("");
    setIsRecurring(false); setRecFreq("daily"); setRecInterval(1); setRecDays([]); setRecEndDate(""); setRecDatesInput("");
  };

  const updateTask = (updated: any) => {
    setTasks((prev: any[]) => {
      const oldTask = prev.find(t => t.id === updated.id);
      let newTasks = prev.map(t => (t.id === updated.id ? updated : t));

      if (oldTask && !oldTask.completed && updated.completed && updated.recurrence && !updated.nextInstanceGenerated) {
        const nextDate = getNextOccurrence(updated.date, updated.recurrence);
        if (nextDate) {
          updated.nextInstanceGenerated = true;
          const nextTask = {
            ...updated,
            id: uid(),
            date: nextDate,
            completed: false,
            progress: 0,
            nextInstanceGenerated: false,
            comments: [],
            subtasks: (updated.subtasks || []).map((st: any) => ({ ...st, completed: false, progress: 0 }))
          };
          newTasks.push(nextTask);
        }
      }
      return newTasks;
    });
  };

  const deleteTask = (id: string) => setTasks((prev: any[]) => prev.filter(t => t.id !== id));

  const tasksByDate = useMemo(() => {
    const map: Record<string, any[]> = {};
    tasks.forEach((t: any) => {
      if (!map[t.date]) map[t.date] = [];
      map[t.date].push(t);
    });
    return map;
  }, [tasks]);

  const groupedTasksByDate = useMemo(() => {
    const groups: Record<string, any[]> = {};
    const sortedTasks = [...tasks].sort((a, b) => Number(b.priority) - Number(a.priority));
    
    sortedTasks.forEach(t => {
      if (hideCompleted && t.completed) return; 

      const isOverdue = t.date && t.date < today && !t.completed;
      const d = isOverdue ? "⚠️ Overdue" : (t.date || "No Date");
      
      if (!groups[d]) groups[d] = [];
      groups[d].push(t);
    });
    return groups;
  }, [tasks, hideCompleted, today]);

  const sortedDates = useMemo(() => {
    return Object.keys(groupedTasksByDate).sort((a, b) => {
      if (a === "⚠️ Overdue") return -1;
      if (b === "⚠️ Overdue") return 1;
      if (a === "No Date") return 1;
      if (b === "No Date") return -1;
      return a.localeCompare(b);
    });
  }, [groupedTasksByDate]);

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
    
    const byTag = tags.map((tag: string) => {
      const tagged = collectTasksWithTag(tasks, tag);
      const count = tagged.length;
      const completedCount = tagged.filter(t => t.completed).length;
      const overdueCount = tagged.filter(t => !t.completed && t.date && t.date < today).length;
      const avgTagProgress = count ? Math.round(tagged.reduce((a,b)=>a+(b.progress||0),0)/count) : 0;
      return { tag, count, completedCount, overdueCount, avgTagProgress };
    });
    return { total, completed, avgProgress, byPriority, byDate, overdue, highPriority, mostProductive, leastProductive, byTag };
  }, [tasks, tasksByDate, today]);

  const tabClass = (active: boolean) => `px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200 whitespace-nowrap flex-1 md:flex-none text-center ${active ? "bg-blue-500 text-white shadow-lg md:scale-105" : "bg-gray-700 text-gray-200 hover:bg-gray-600"}`;
  const allTags = useMemo(() => collectAllTags(tasks), [tasks]);

  const flattenedTasks = useMemo(() => {
    const out: any[] = [];
    function walk(list: any[]) {
      (list || []).forEach(t => { out.push(t); if (t.subtasks) walk(t.subtasks); });
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
      if (q) return (t.title || "").toLowerCase().includes(q) || (t.comments || []).some((c: string) => c.toLowerCase().includes(q));
      return true;
    });
  }, [flattenedTasks, findQuery, findPriority, findTag, findCompleted, findDateFrom, findDateTo]);

  const byDateDetailed = useMemo(() => {
      const map: Record<string, any> = {};
      (analyticsData.byDate || []).forEach(d => {
        const tasksForDate = tasksByDate[d.date] || [];
        const completedCount = tasksForDate.filter(t => t.completed).length;
        const avg = tasksForDate.length ? Math.round(tasksForDate.reduce((a, b) => a + (b.progress || 0), 0) / tasksForDate.length) : 0;
        map[d.date] = { date: d.date, count: d.count, completedCount, avgProgress: avg, completedPct: tasksForDate.length ? Math.round((completedCount / tasksForDate.length) * 100) : 0 };
      });
      return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
    }, [analyticsData.byDate, tasksByDate]);

  const byTagDetailed = useMemo(() => (analyticsData.byTag || []).map(t => ({ 
      ...t, 
      remaining: t.count - t.completedCount - t.overdueCount,
      overdue: t.overdueCount 
  })), [analyticsData.byTag]);
  
  const priorityWithPct = useMemo(() => {
    const total = analyticsData.byPriority.reduce((s,p)=>s+p.value,0) || 1;
    return analyticsData.byPriority.map((p,i) => ({ ...p, pct: Math.round((p.value/total)*100), color: Object.values(priorityColor)[i] }));
  }, [analyticsData.byPriority]);

  const toggleDay = (day: number) => {
    setRecDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-slate-100 p-3 sm:p-8">
      <div className="max-w-7xl mx-auto space-y-6 sm:space-y-8">
        
        <div className="flex justify-between items-center flex-wrap gap-4">
            <h1 className="text-3xl sm:text-4xl font-bold text-white">Tasks DB</h1>
            
            <div className="flex items-center gap-2 sm:gap-3 bg-slate-800 p-2 rounded-xl border border-slate-700 w-full md:w-auto">
                <Select value={activeProfile} onValueChange={setActiveProfile}>
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white flex-1 md:w-40 h-8"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-slate-800 text-white">
                    {profiles.map(p => (<SelectItem key={p} value={p}>{p}</SelectItem>))}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-1 border-l border-slate-600 pl-2 sm:pl-3">
                    <Input placeholder="New profile" value={newProfileName} onChange={e => setNewProfileName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addProfile()} className="bg-slate-700 border-slate-600 text-white w-24 sm:w-28 h-8 text-xs" />
                    <Button size="sm" className="bg-blue-600 hover:bg-blue-500 h-8 px-2 sm:px-3" onClick={addProfile}>+</Button>
                </div>
                {profiles.length > 1 && (
                  <Button size="sm" variant="ghost" className="text-red-400 hover:bg-red-900/30 hover:text-red-300 h-8 px-2" onClick={() => deleteProfile(activeProfile)}>🗑️</Button>
                )}
            </div>
        </div>

        <Card className="bg-slate-800 border border-slate-700 rounded-2xl shadow-xl">
          <CardContent className="p-3 sm:p-4 flex gap-2 flex-wrap overflow-x-auto scrollbar-hide">
            <button className={tabClass(activeTab === "tasks")} onClick={() => setActiveTab("tasks")}>Tasks</button>
            <button className={tabClass(activeTab === "calendar")} onClick={() => setActiveTab("calendar")}>Calendar</button>
            <button className={tabClass(activeTab === "tags")} onClick={() => setActiveTab("tags")}>Tags</button>
            <button className={tabClass(activeTab === "analytics")} onClick={() => setActiveTab("analytics")}>Analytics</button>
            <button className={tabClass(activeTab === "find")} onClick={() => setActiveTab("find")}>Find</button>
          </CardContent>
        </Card>

        {activeTab === "tasks" && (
          <Card className="bg-slate-800 border border-slate-700 rounded-2xl shadow-xl">
            <CardContent className="p-4 sm:p-6 space-y-6">
              
              <div className="flex flex-col gap-4 bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <div className="flex gap-3 flex-wrap items-center">
                  <Input placeholder="What needs to be done?" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTask()} className="bg-slate-700 border-slate-600 text-white w-full md:w-auto md:flex-1" />
                  <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="bg-slate-700 border-slate-600 text-white w-full sm:w-36" />
                  <Select value={priority} onValueChange={setPriority}>
                    <SelectTrigger className="bg-slate-700 border-slate-600 text-white w-full sm:w-36"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-slate-800 text-white">
                      {priorities.map(p => (<SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>))}
                    </SelectContent>
                  </Select>
                  <Input placeholder="Tags (comma separated)" value={tagInput} onChange={e => setTagInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTask()} className="bg-slate-700 border-slate-600 text-white w-full md:w-48 hidden md:block" />
                  
                  <div className="flex items-center gap-2 bg-slate-700 px-3 py-2 rounded-md border border-slate-600 cursor-pointer select-none w-full sm:w-auto" onClick={() => setIsRecurring(!isRecurring)}>
                    <input type="checkbox" checked={isRecurring} onChange={() => {}} className="accent-blue-500 pointer-events-none" />
                    <span className="text-sm">Recurring</span>
                  </div>

                  <Button className="bg-blue-600 hover:bg-blue-500 w-full md:w-auto font-bold tracking-wide shadow-md" onClick={addTask}>Add Task</Button>
                </div>

                <AnimatePresence>
                  {isRecurring && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="bg-slate-800 border border-slate-600 p-4 rounded-xl flex gap-4 flex-wrap items-center overflow-hidden">
                      <Select value={recFreq} onValueChange={setRecFreq}>
                        <SelectTrigger className="bg-slate-700 border-slate-600 text-white w-full sm:w-36"><SelectValue placeholder="Frequency" /></SelectTrigger>
                        <SelectContent className="bg-slate-800 text-white">
                          <SelectItem value="daily">Daily</SelectItem>
                          <SelectItem value="weekly">Weekly</SelectItem>
                          <SelectItem value="monthly">Monthly</SelectItem>
                          <SelectItem value="yearly">Yearly</SelectItem>
                          <SelectItem value="custom_dates">Specific Dates</SelectItem>
                        </SelectContent>
                      </Select>

                      {['daily', 'weekly', 'monthly', 'yearly'].includes(recFreq) && (
                        <div className="flex items-center gap-2 bg-slate-700/50 p-1 px-3 rounded-lg border border-slate-600/50">
                          <span className="text-sm text-slate-300">Every</span>
                          <Input type="number" min="1" value={recInterval} onChange={e => setRecInterval(Number(e.target.value))} className="bg-slate-800 border-slate-600 text-white w-16 h-8 text-center" />
                          <span className="text-sm text-slate-300">
                            {recFreq === 'daily' ? 'days' : recFreq === 'weekly' ? 'weeks' : recFreq === 'monthly' ? 'months' : 'years'}
                          </span>
                        </div>
                      )}

                      {recFreq === 'weekly' && (
                        <div className="flex gap-1 border-l border-slate-600 pl-4 ml-2">
                           {["S","M","T","W","T","F","S"].map((d, i) => (
                              <button key={i} onClick={() => toggleDay(i)} className={`w-8 h-8 rounded-full text-xs font-bold transition-colors ${recDays.includes(i) ? 'bg-blue-500 text-white shadow-md' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'}`}>
                                {d}
                              </button>
                           ))}
                        </div>
                      )}

                      {recFreq === 'custom_dates' && (
                        <Input placeholder="e.g. 2026-06-01, 2026-12-25" value={recDatesInput} onChange={e => setRecDatesInput(e.target.value)} className="bg-slate-700 border-slate-600 text-white w-full sm:w-64" />
                      )}

                      <div className="flex items-center gap-2 sm:ml-auto w-full sm:w-auto">
                        <span className="text-sm text-slate-400 font-medium">Ends:</span>
                        <Input type="date" value={recEndDate} onChange={e => setRecEndDate(e.target.value)} className="bg-slate-700 border-slate-600 text-slate-300 flex-1 sm:w-36 h-9" />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="flex justify-between items-end border-b border-slate-700 pb-2">
                 <h2 className="text-xl font-bold text-slate-200">Your Tasks</h2>
                 <div className="flex items-center gap-2 bg-slate-900/50 px-3 py-1.5 rounded-lg border border-slate-700 cursor-pointer select-none" onClick={() => setHideCompleted(!hideCompleted)}>
                    <input type="checkbox" checked={hideCompleted} onChange={() => {}} className="accent-blue-500 pointer-events-none" />
                    <span className="text-sm text-slate-300 font-medium">Hide Completed</span>
                 </div>
              </div>

              <div className="space-y-4">
                {sortedDates.length === 0 && (
                    <div className="text-center text-slate-400 py-10 bg-slate-900/30 rounded-xl border border-dashed border-slate-700">
                        {hideCompleted ? "No active tasks. You're all caught up!" : "No tasks found. Add one above!"}
                    </div>
                )}
                
                {sortedDates.map(dateKey => {
                  const tasksForThisDate = groupedTasksByDate[dateKey] || [];
                  const priorityCounts: Record<string, number> = { "4": 0, "3": 0, "2": 0, "1": 0 };
                  
                  tasksForThisDate.forEach(t => { 
                      if (t.priority && priorityCounts[t.priority] !== undefined) {
                          priorityCounts[t.priority]++; 
                      }
                  });

                  const isOverdueGroup = dateKey === "⚠️ Overdue";

                  return (
                    <div key={dateKey} className={`bg-slate-800 border rounded-xl overflow-hidden shadow-sm transition-colors ${isOverdueGroup ? 'border-red-900/50' : 'border-slate-700'}`}>
                      <div
                        className={`p-4 cursor-pointer flex justify-between items-center transition-colors ${isOverdueGroup ? 'bg-red-950/20 hover:bg-red-900/30' : 'bg-slate-700/60 hover:bg-slate-700'}`}
                        onClick={() => setExpandedDates(prev => ({ ...prev, [dateKey]: !prev[dateKey] }))}
                      >
                        <div className="flex items-center gap-3">
                          <span 
                            className={`transform transition-transform duration-200 text-xs ${isOverdueGroup ? 'text-red-400' : 'text-slate-400'}`}
                            style={{ transform: expandedDates[dateKey] ? 'rotate(90deg)' : 'rotate(0deg)' }}
                          >
                            ▶
                          </span>
                          <span className={`text-base sm:text-lg font-bold ${isOverdueGroup ? 'text-red-400' : 'text-slate-200'}`}>
                            {dateKey === today ? `Today (${dateKey})` : dateKey}
                          </span>
                        </div>
                        
                        <div className="flex items-center gap-2">
                            {Object.entries(priorityCounts)
                                .sort(([a], [b]) => Number(b) - Number(a))
                                .map(([p, count]) => count > 0 ? (
                                <span key={p} className={`text-xs border text-slate-200 px-2 py-1 rounded-md hidden sm:flex items-center gap-1 shadow-sm ${isOverdueGroup ? 'bg-red-950/50 border-red-900/50' : 'bg-slate-800/80 border-slate-600'}`} title={priorities.find(pr=>pr.value===p)?.label}>
                                    <span>{priorityIcon[p as keyof typeof priorityIcon]}</span>
                                    <span className="font-medium">{count}</span>
                                </span>
                            ) : null)}
                            
                            <span className={`text-sm text-white font-bold px-3 py-1 rounded-full ml-1 ${isOverdueGroup ? 'bg-red-600' : 'bg-slate-600'}`}>
                              {tasksForThisDate.length}
                            </span>
                        </div>
                      </div>
                      
                      <AnimatePresence>
                        {expandedDates[dateKey] && (
                          <motion.div 
                            initial={{ height: 0, opacity: 0 }} 
                            animate={{ height: "auto", opacity: 1 }} 
                            exit={{ height: 0, opacity: 0 }} 
                            className="overflow-hidden bg-slate-800"
                          >
                            <div className="p-3 sm:p-4 space-y-3 border-t border-slate-700/50 bg-slate-900/20">
                              {tasksForThisDate.map(task => (
                                <TaskNode key={task.id} task={task} onChange={updateTask} onDelete={deleteTask} />
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === "calendar" && (
          <Card className="bg-slate-800 border border-slate-700 rounded-2xl shadow-xl">
            <CardContent className="p-4 sm:p-6 space-y-6">
              <div className="flex justify-between items-center">
                <Button variant="outline" size="sm" className="border-slate-600 bg-slate-700 text-white hover:bg-slate-600 px-2 sm:px-4" onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))}>Prev</Button>
                <div className="text-xl sm:text-2xl font-bold tracking-wide text-slate-100">{currentMonth.toLocaleString("default", { month: "long" })} {currentMonth.getFullYear()}</div>
                <Button variant="outline" size="sm" className="border-slate-600 bg-slate-700 text-white hover:bg-slate-600 px-2 sm:px-4" onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))}>Next</Button>
              </div>

              <div className="grid grid-cols-7 gap-1 sm:gap-2 text-center text-xs sm:text-sm font-bold text-slate-400 uppercase tracking-wider mb-2">
                {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => <div key={d}>{d.substring(0, 3)}</div>)}
              </div>

              <div className="grid grid-cols-7 gap-1 sm:gap-2">
                {calendarDays.map((day, idx) => {
                  if (!day) return <div key={idx} className="bg-slate-900/30 rounded-lg sm:rounded-xl border border-dashed border-slate-700/30 min-h-[60px] md:min-h-[80px]"></div>;
                  const iso = toISODate(day);
                  const isToday = iso === today;
                  const dayTasks = tasksByDate[iso] || [];
                  const avg = dayTasks.length ? dayTasks.reduce((a,b)=>a+(b.progress||0),0)/dayTasks.length : 0;
                  const bg = avg === 100 ? "bg-green-600" : avg > 0 ? "bg-yellow-600" : dayTasks.length ? "bg-red-600" : "bg-slate-700";
                  
                  return (
                    <div 
                      key={iso} 
                      onClick={() => { 
                        setExpandedDates(prev => ({ ...prev, [iso]: true })); 
                        setActiveTab("tasks"); 
                      }} 
                      className={`p-1 sm:p-3 min-h-[60px] md:min-h-[80px] flex flex-col rounded-lg sm:rounded-xl cursor-pointer ${bg} hover:opacity-80 transition-all ${isToday ? 'ring-2 sm:ring-4 ring-blue-500 ring-offset-2 sm:ring-offset-4 ring-offset-slate-800 shadow-xl sm:shadow-2xl scale-[1.05] z-10' : 'shadow-md border border-white/5'}`}
                    >
                      <div className="flex flex-col sm:flex-row justify-between items-center sm:items-start mb-auto w-full">
                          <span className={`font-bold text-sm sm:text-lg ${isToday ? 'text-white drop-shadow-md' : 'text-slate-100'}`}>{day.getDate()}</span>
                          {isToday && <span className="text-[8px] sm:text-[10px] bg-blue-500 text-white px-1 sm:px-2 py-0.5 rounded shadow-sm uppercase tracking-widest font-black mt-1 sm:mt-0">Today</span>}
                      </div>
                      {dayTasks.length > 0 && <div className="text-[10px] sm:text-xs font-bold text-white/95 bg-black/20 px-1 sm:px-2 py-1 rounded mt-1 sm:mt-2 text-center w-full truncate">{dayTasks.length} tasks</div>}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === "tags" && (
          <Card className="bg-slate-800 border border-slate-700 rounded-2xl shadow-xl">
            <CardContent className="p-4 sm:p-6 space-y-4">
              <div className="text-xl font-bold border-b border-slate-700 pb-2">Tag Management</div>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
                {allTags.length === 0 && <div className="text-slate-400">No tags yet. Add tags to tasks to categorize them.</div>}
                
                {allTags.map((tag: string) => {
                  const rawTasksForTag = collectTasksWithTag(tasks, tag);
                  
                  const seenRecurringTitles = new Set();
                  const uniqueTasksForTag = [...rawTasksForTag]
                      .sort((a, b) => {
                         if (a.completed !== b.completed) return a.completed ? 1 : -1;
                         return b.date.localeCompare(a.date);
                      })
                      .filter(t => {
                          if (t.recurrence && t.recurrence.frequency !== 'none') {
                              if (seenRecurringTitles.has(t.title)) return false;
                              seenRecurringTitles.add(t.title);
                              return true;
                          }
                          return true;
                      });

                  return (
                    <div key={tag} className="bg-slate-900/50 border border-slate-700 p-4 rounded-xl shadow-sm">
                      <div className="flex items-center justify-between mb-3 border-b border-slate-700/50 pb-2">
                        <div className="font-bold text-lg text-indigo-300 truncate mr-2">#{tag}</div>
                        <div className="text-sm bg-indigo-900/40 text-indigo-200 px-2 py-1 rounded-md font-medium whitespace-nowrap">
                            {uniqueTasksForTag.length} tasks
                        </div>
                      </div>
                      <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                        {uniqueTasksForTag.map(t => {
                          // FEATURE ADDITION: Format Frequency Label for summary view
                          const isRec = t.recurrence && t.recurrence.frequency !== 'none';
                          const freqLabel = isRec ? t.recurrence.frequency.replace('_', ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()) : '';

                          return (
                            <details key={t.id} className="bg-slate-800 border border-slate-700 p-2 rounded-lg group">
                              <summary className="cursor-pointer text-slate-200 font-medium list-none flex justify-between items-center gap-2">
                                  <span className={`truncate ${t.completed ? 'line-through text-slate-400' : ''}`}>
                                    {t.title}
                                  </span>
                                  
                                  {/* FEATURE ADDITION: Replaced hardcoded t.date with recurrence logic */}
                                  <span className="text-xs text-slate-400 whitespace-nowrap group-open:hidden">
                                      {isRec ? `🔁 ${freqLabel}` : t.date}
                                  </span>
                              </summary>
                              
                              <div className="mt-3 text-sm text-slate-300 space-y-1 bg-slate-900/50 p-2 rounded border border-slate-700/50">
                                
                                {/* FEATURE ADDITION: Recurrence Specific Details View */}
                                {isRec ? (
                                    <>
                                        <div className="flex justify-between items-center">
                                            <div><span className="text-slate-400">Recurrence:</span> <span className="capitalize">{freqLabel}</span> {t.recurrence.interval > 1 && `(Every ${t.recurrence.interval})`}</div>
                                        </div>
                                        {t.recurrence.frequency === 'custom_dates' ? (
                                            <div><span className="text-slate-400">Dates:</span> <span className="break-words whitespace-normal block mt-1">{(t.recurrence.specificDates || []).join(', ')}</span></div>
                                        ) : (
                                            <>
                                                <div><span className="text-slate-400">Active Date:</span> {t.date}</div>
                                                {t.recurrence.endDate && <div><span className="text-slate-400">Ends:</span> {t.recurrence.endDate}</div>}
                                            </>
                                        )}
                                    </>
                                ) : (
                                    <div><span className="text-slate-400">Date:</span> {t.date}</div>
                                )}
                                
                                <div><span className="text-slate-400">Priority:</span> {priorities.find(p=>p.value===t.priority)?.label || t.priority}</div>
                                <div className="flex items-center gap-2">
                                    <span className="text-slate-400">Progress:</span> 
                                    <div className="flex-1 bg-slate-700 h-1.5 rounded-full overflow-hidden">
                                        <div className="bg-blue-500 h-full" style={{width: `${t.progress||0}%`}}></div>
                                    </div>
                                    <span className="text-xs">{t.progress || 0}%</span>
                                </div>
                              </div>
                            </details>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === "find" && (
          <Card className="bg-slate-800 border border-slate-700 rounded-2xl shadow-xl">
            <CardContent className="p-4 sm:p-6 space-y-6">
              <div className="text-xl font-bold border-b border-slate-700 pb-2">Advanced Search</div>
              <div className="flex gap-3 items-center flex-wrap bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <Input placeholder="Search titles or comments..." value={findQuery} onChange={e => setFindQuery(e.target.value)} className="bg-slate-700 border-slate-600 text-white w-full md:w-72" />
                <Select value={findPriority} onValueChange={setFindPriority}>
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white w-full sm:w-40"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-slate-800 text-white">
                    <SelectItem value="all">All priorities</SelectItem>
                    {priorities.map(p => (<SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>))}
                  </SelectContent>
                </Select>
                <Select value={findTag} onValueChange={setFindTag}>
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white w-full sm:w-40"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-slate-800 text-white">
                    <SelectItem value="all">All tags</SelectItem>
                    {allTags.map(tag => (<SelectItem key={tag} value={tag}>{tag}</SelectItem>))}
                  </SelectContent>
                </Select>
                <Select value={findCompleted} onValueChange={setFindCompleted}>
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white w-full sm:w-36"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-slate-800 text-white">
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                  </SelectContent>
                </Select>
                <Input type="date" value={findDateFrom} onChange={e=>setFindDateFrom(e.target.value)} className="bg-slate-700 border-slate-600 text-white w-full sm:w-36" title="From Date" />
                <Input type="date" value={findDateTo} onChange={e=>setFindDateTo(e.target.value)} className="bg-slate-700 border-slate-600 text-white w-full sm:w-36" title="To Date" />
              </div>

              <div className="space-y-3">
                {findResults.length === 0 ? (
                    <div className="text-center text-slate-400 py-8 bg-slate-900/30 rounded-xl border border-dashed border-slate-700">No results found matching your criteria.</div>
                ) : (
                    <div className="text-sm text-slate-400 font-medium mb-2 pl-1">Found {findResults.length} task(s)</div>
                )}
                {findResults.map(t => (
                  <details key={t.id} className="bg-slate-800 border border-slate-700 p-4 rounded-xl group hover:border-slate-500 transition-colors">
                    <summary className="cursor-pointer text-slate-200 font-medium list-none flex justify-between items-center gap-2">
                        <div className="flex items-center gap-3 overflow-hidden">
                            <span className="text-xs bg-slate-700 px-2 py-1 rounded text-slate-300 hidden sm:block group-open:hidden">View</span>
                            <span className={`text-base sm:text-lg truncate ${t.completed ? 'line-through text-slate-400' : ''}`}>{t.title}</span>
                        </div>
                        <span className="text-xs sm:text-sm font-mono text-slate-400 bg-slate-900 px-2 py-1 rounded whitespace-nowrap">{t.date}</span>
                    </summary>
                    <div className="mt-4 grid md:grid-cols-2 gap-4 text-sm text-slate-300 bg-slate-900/50 p-4 rounded-lg border border-slate-700/50">
                        <div className="space-y-2">
                            <div><span className="text-slate-500 font-medium w-16 sm:w-20 inline-block">Status:</span> {t.completed ? <span className="text-green-400 font-bold">Completed</span> : <span className="text-yellow-400 font-bold">Active</span>}</div>
                            <div><span className="text-slate-500 font-medium w-16 sm:w-20 inline-block">Priority:</span> {priorities.find(p=>p.value===t.priority)?.label || t.priority}</div>
                            <div className="flex items-center gap-2">
                                <span className="text-slate-500 font-medium w-16 sm:w-20 inline-block">Progress:</span> 
                                <div className="flex-1 max-w-[150px] bg-slate-700 h-2 rounded-full overflow-hidden">
                                    <div className="bg-blue-500 h-full" style={{width: `${t.progress||0}%`}}></div>
                                </div>
                                <span className="font-mono text-xs">{t.progress || 0}%</span>
                            </div>
                        </div>
                        <div>
                            <div className="text-slate-500 font-medium mb-1">Tags:</div>
                            <div className="flex gap-1 flex-wrap">
                                {(t.tags||[]).length > 0 ? (t.tags||[]).map((tag: string) => <span key={tag} className="bg-indigo-900/40 text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded text-xs">#{tag}</span>) : <span className="text-slate-600 italic">None</span>}
                            </div>
                        </div>
                    </div>
                  </details>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === "analytics" && (
          <Card className="bg-slate-800 border border-slate-700 rounded-2xl shadow-xl">
            <CardContent className="p-4 sm:p-6 space-y-6">
              
              <div className="text-xl font-bold border-b border-slate-700 pb-2">Overview</div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6 text-center">
                <div className="bg-slate-900/50 border border-slate-700 p-3 sm:p-4 rounded-xl shadow-sm">
                  <div className="text-3xl sm:text-4xl font-black text-blue-400">{analyticsData.total}</div>
                  <div className="text-slate-400 font-medium mt-1 uppercase tracking-wider text-[10px] sm:text-xs">Total Tasks</div>
                </div>
                <div className="bg-slate-900/50 border border-slate-700 p-3 sm:p-4 rounded-xl shadow-sm">
                  <div className="text-3xl sm:text-4xl font-black text-green-400">{analyticsData.completed}</div>
                  <div className="text-slate-400 font-medium mt-1 uppercase tracking-wider text-[10px] sm:text-xs">Completed</div>
                </div>
                <div className="bg-slate-900/50 border border-slate-700 p-3 sm:p-4 rounded-xl shadow-sm">
                  <div className="text-3xl sm:text-4xl font-black text-indigo-400">{analyticsData.avgProgress}%</div>
                  <div className="text-slate-400 font-medium mt-1 uppercase tracking-wider text-[10px] sm:text-xs">Avg Progress</div>
                </div>
                <div className="bg-slate-900/50 border border-red-900/50 p-3 sm:p-4 rounded-xl shadow-sm relative overflow-hidden">
                  <div className="absolute inset-0 bg-red-500/5"></div>
                  <div className="text-3xl sm:text-4xl font-black text-red-500 relative z-10">{analyticsData.overdue}</div>
                  <div className="text-red-400/80 font-medium mt-1 uppercase tracking-wider text-[10px] sm:text-xs relative z-10">Overdue</div>
                </div>
              </div>

              <div className="grid lg:grid-cols-2 gap-6">
                <div className="bg-slate-900/30 border border-slate-700 p-4 sm:p-5 rounded-xl overflow-hidden">
                  <div className="text-base sm:text-lg font-bold mb-4 flex items-center gap-2"><span className="w-2 h-6 bg-blue-500 rounded-full inline-block"></span> Tasks Over Time</div>
                  <div className="h-[250px] sm:h-[350px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={byDateDetailed} margin={{ top: 10, right: 10, left: -20, bottom: 40 }}>
                        <CartesianGrid stroke="#334155" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} angle={-45} textAnchor="end" height={60} axisLine={false} tickLine={false} />
                        <YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#94a3b8'}} axisLine={false} tickLine={false} />
                        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#94a3b8'}} axisLine={false} tickLine={false} />
                        <Tooltip contentStyle={{backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '8px', color: '#f8fafc'}} />
                        <BarChart data={byDateDetailed}>
                          <Bar dataKey="count" fill="#3b82f6" radius={[4,4,0,0]} />
                        </BarChart>
                        <Line type="monotone" dataKey="completedPct" stroke="#22c55e" strokeWidth={3} dot={{r: 4, fill: '#1e293b', strokeWidth: 2}} activeDot={{r: 6}} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-2 text-[10px] sm:text-xs font-medium text-slate-400 flex justify-center gap-4">
                      <span className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-500 rounded-sm inline-block"></span> Total Tasks</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-1 bg-green-500 rounded-full inline-block"></span> % Completed</span>
                  </div>
                </div>

                <div className="bg-slate-900/30 border border-slate-700 p-4 sm:p-5 rounded-xl overflow-hidden">
                  <div className="text-base sm:text-lg font-bold mb-4 flex items-center gap-2"><span className="w-2 h-6 bg-indigo-500 rounded-full inline-block"></span> Tag Insights</div>
                  <div className="h-[250px] sm:h-[350px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={byTagDetailed} margin={{ top: 10, right: 10, left: -20, bottom: 80 }}>
                        <CartesianGrid stroke="#334155" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="tag" tick={{ fontSize: 10, fill: '#94a3b8' }} angle={-45} textAnchor="end" height={70} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10, fill: '#94a3b8'}} axisLine={false} tickLine={false} />
                        <Tooltip cursor={{fill: '#334155', opacity: 0.4}} contentStyle={{backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '8px', color: '#f8fafc'}} />
                        
                        <Bar dataKey="completedCount" stackId="a" fill="#22c55e" name="Completed" />
                        <Bar dataKey="remaining" stackId="a" fill="#eab308" name="Remaining" />
                        <Bar dataKey="overdue" stackId="a" fill="#ef4444" name="Overdue" radius={[4,4,0,0]} />
                        
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  
                  <div className="mt-2 text-[10px] sm:text-xs font-medium text-slate-400 flex justify-center gap-2 sm:gap-4 flex-wrap">
                      <span className="flex items-center gap-1"><span className="w-3 h-3 bg-green-500 rounded-sm inline-block"></span> Completed</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 bg-yellow-500 rounded-sm inline-block"></span> Remaining</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 bg-red-500 rounded-sm inline-block"></span> Overdue</span>
                  </div>
                </div>
              </div>

              <div className="grid lg:grid-cols-3 gap-6">
                  <div className="bg-slate-900/30 border border-slate-700 p-4 sm:p-5 rounded-xl col-span-1">
                    <div className="text-base sm:text-lg font-bold mb-4 flex items-center gap-2"><span className="w-2 h-6 bg-orange-500 rounded-full inline-block"></span> Priorities</div>
                    <div style={{ height: 220 }}>
                      <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={priorityWithPct}
                              dataKey="value"
                              nameKey="name"
                              cx="50%"
                              cy="50%"
                              outerRadius={80}
                              innerRadius={50}
                              paddingAngle={2}
                              stroke="none"
                            >
                              {priorityWithPct.map((p, i) => (
                                <Cell key={i} fill={p.color} />
                              ))}
                            </Pie>
                            <Tooltip contentStyle={{backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '8px', color: '#f8fafc'}} formatter={(value) => `${value} tasks`} />
                          </PieChart>
                        </ResponsiveContainer>
                    </div>
                    <div className="mt-4 space-y-2">
                      {priorityWithPct.map((p, i) => (
                        <div key={i} className="flex items-center justify-between bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700/50">
                          <div className="flex items-center gap-2">
                              <span style={{ width: 10, height: 10, background: p.color, display: 'inline-block', borderRadius: 2 }} />
                              <span className="text-sm font-medium text-slate-200">{p.name.replace(/[^A-Za-z]/g, '').trim()}</span>
                          </div>
                          <span className="text-sm text-slate-400 font-mono">{p.value} ({p.pct}%)</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-slate-900/30 border border-slate-700 p-4 sm:p-5 rounded-xl col-span-1 lg:col-span-2">
                    <div className="text-base sm:text-lg font-bold mb-4 flex items-center gap-2"><span className="w-2 h-6 bg-purple-500 rounded-full inline-block"></span> Upcoming & Immediate Focus</div>
                    <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1 sm:pr-2">
                      {tasks.filter(t => !t.completed && t.date && t.date >= today).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,8).map(t => (
                        <div key={t.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-800 p-3 rounded-xl border border-slate-700 hover:border-slate-500 transition-colors">
                          <div>
                            <div className="font-semibold text-slate-200 text-base">{t.title}</div>
                            <div className="text-sm text-slate-400 font-mono mt-0.5 flex items-center gap-2">
                                📅 {t.date} 
                                {t.date === today && <span className="bg-blue-500/20 text-blue-400 px-1.5 py-0 rounded text-[10px] uppercase font-bold tracking-wider">Today</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-3 sm:ml-auto">
                              <div className="text-left sm:text-right">
                                  <div className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wider mb-1">Priority</div>
                                  <div className="flex items-center gap-1">
                                      <span style={{ width: 8, height: 8, background: priorityColor[t.priority as keyof typeof priorityColor] || '#64748b', borderRadius: '50%' }} />
                                      <span className="text-sm font-medium text-slate-300">{priorities.find(p=>p.value===t.priority)?.label.replace(/[^A-Za-z]/g, '').trim()}</span>
                                  </div>
                              </div>
                          </div>
                        </div>
                      ))}
                      {tasks.filter(t => !t.completed && t.date && t.date >= today).length === 0 && (
                          <div className="text-center py-10 bg-slate-800/50 rounded-xl border border-dashed border-slate-700 text-slate-400 text-sm">
                              No upcoming tasks on the radar. Relax!
                          </div>
                      )}
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
