"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import { MapPin, Pause, Play } from "lucide-react";
import { hostLocation } from "../../lib/host-locations";

export interface GlobeHost { id: string; region: string | null; active: boolean }
type Node = GlobeHost & { coordinates: [number, number]; label: string; approximate: boolean };

export default function Globe({ hosts }: { hosts: GlobeHost[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const landRef = useRef<d3.GeoPermissibleObjects | null>(null);
  const rotationRef = useRef<[number, number]>([-35, -20]);
  const redrawRef = useRef<() => void>(() => {});
  const rotatingRef = useRef(true);
  const centeredRef = useRef(false);
  const [rotating, setRotating] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [countries, setCountries] = useState<Record<string, [number, number]>>({});
  const nodes = useMemo(() => hosts.flatMap((h) => {
    const location = hostLocation(h.region, countries);
    return location ? [{ ...h, ...location }] : [];
  }), [hosts, countries]);
  const locations = [...new Map(nodes.map((node) => [node.region, node])).values()];

  useEffect(() => {
    nodesRef.current = nodes;
    if (!centeredRef.current && nodes.length) {
      const [lon, lat] = nodes[nodes.length - 1].coordinates;
      rotationRef.current = [-lon, -lat];
      centeredRef.current = true;
    }
    redrawRef.current();
  }, [nodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rotatingRef.current = !reduced;
    setRotating(!reduced);
    const projection = d3.geoOrthographic().clipAngle(90);
    const path = d3.geoPath(projection, ctx);
    const graticule = d3.geoGraticule10();
    let width = 0, height = 0;
    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      projection.rotate([...rotationRef.current, 0]);
      ctx.beginPath(); path({ type: "Sphere" });
      ctx.fillStyle = "#0D151C"; ctx.fill();
      ctx.strokeStyle = "#26343E"; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); path(graticule);
      ctx.strokeStyle = "#24303A"; ctx.lineWidth = 0.5; ctx.stroke();
      if (landRef.current) {
        ctx.beginPath(); path(landRef.current);
        ctx.fillStyle = "#19252D"; ctx.fill();
        ctx.strokeStyle = "#32414C"; ctx.lineWidth = 0.5; ctx.stroke();
      }
      for (const node of nodesRef.current) {
        const center: [number, number] = [-rotationRef.current[0], -rotationRef.current[1]];
        if (d3.geoDistance(node.coordinates, center) >= Math.PI / 2 - 0.03) continue;
        const point = projection(node.coordinates);
        if (!point) continue;
        const [x, y] = point;
        ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2);
        ctx.fillStyle = node.active ? "rgba(88,198,150,0.13)" : "rgba(220,82,74,0.13)"; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = node.active ? "#67CFA2" : "#E57870"; ctx.fill();
        ctx.strokeStyle = "#0D151C"; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillStyle = "#C7D6D0"; ctx.fillText(node.label, x + 11, y + 4);
      }
    }
    redrawRef.current = draw;
    function resize() {
      if (!canvas || !ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth; height = canvas.clientHeight;
      canvas.width = width * dpr; canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      projection.scale(Math.min(width, height) * 0.44).translate([width / 2, height * 0.49]);
      draw();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(canvas); resize();
    const controller = new AbortController();
    d3.json<Topology<{ countries: GeometryCollection }>>("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json", { signal: controller.signal }).then((topo) => {
      if (!topo || controller.signal.aborted) return;
      const land = feature(topo, topo.objects.countries) as unknown as GeoJSON.FeatureCollection;
      landRef.current = land;
      const centers: Record<string, [number, number]> = {};
      for (const country of land.features) if (country.properties?.name) centers[country.properties.name] = d3.geoCentroid(country);
      setCountries(centers); draw();
    }).catch(() => {});
    let previous = 0;
    const timer = d3.timer((elapsed) => {
      const delta = Math.min(100, elapsed - previous); previous = elapsed;
      if (!rotatingRef.current) return;
      rotationRef.current[0] += delta * 0.005;
      draw();
    });
    return () => { controller.abort(); timer.stop(); observer.disconnect(); redrawRef.current = () => {}; };
  }, []);

  function focus(node: Node) {
    rotationRef.current = [-node.coordinates[0], -node.coordinates[1]];
    rotatingRef.current = false; setRotating(false); setSelected(node.region); redrawRef.current();
  }
  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="h-full w-full" aria-label={`Host network globe: ${nodes.length} of ${hosts.length} hosts mapped`} />
      <button className="absolute right-4 top-3 inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#101A21]/90 px-2.5 py-1.5 text-[11px] text-[#A5B8BD] hover:bg-[#203039]" onClick={() => { rotatingRef.current = !rotating; setRotating(!rotating); setSelected(null); }}>
        {rotating ? <Pause size={11} /> : <Play size={11} />}{rotating ? "Pause rotation" : "Rotate globe"}
      </button>
      <div className="absolute bottom-2 left-4 right-4 flex flex-wrap items-center gap-2">
        {locations.map((node) => <button key={node.region} onClick={() => focus(node)} title={node.approximate ? "Approximate country location" : "Reported region center"} aria-pressed={selected === node.region} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] transition ${selected === node.region ? "border-[#48765F] bg-[#1D3B2E] text-[#ACE1BF]" : "border-white/10 bg-[#111C23]/90 text-[#BBCACB] hover:bg-[#203039]"}`}><MapPin size={11} />{node.label}{node.approximate ? " (approx.)" : ""}<span className="text-[#79928E]">{nodes.filter((n) => n.region === node.region).length}</span></button>)}
        <span className="ml-auto text-[10px] text-[#74868C]">{nodes.length} mapped{hosts.length > nodes.length ? ` · ${hosts.length - nodes.length} without a mapped location` : ""}</span>
      </div>
    </div>
  );
}
