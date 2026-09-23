import { BaseEdge, EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react';
import type { RelationshipRoute } from '../shared/routing';
import './aggregate-relationships.css';

export type RelationshipEdgeData = { route: RelationshipRoute; label: string; onSelect: () => void };
export type RoutedEdge = Edge<RelationshipEdgeData, 'relationship'>;

export function RelationshipEdge({ id, data, selected, style, markerStart, markerEnd, interactionWidth }: EdgeProps<RoutedEdge>) {
  if (!data) return null;
  const { route, label } = data;
  return <g data-route-source-side={route.sourceHandle} data-route-target-side={route.targetHandle} data-route-obstructed={route.obstructed} data-aggregate-relationship="true">
    <BaseEdge id={id} path={route.path} style={style} markerStart={markerStart} markerEnd={markerEnd} interactionWidth={interactionWidth}/>
    <EdgeLabelRenderer>
      {label && <button type="button" className={`relationship-edge-label aggregate-edge-label nodrag nopan ${selected ? 'selected' : ''}`} style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${route.label.x}px, ${route.label.y}px)`, width: route.labelWidth, maxWidth: route.labelWidth, pointerEvents: 'all' }} title="Inspect contributing relationships" aria-label={`Inspect ${label}`} onClick={event => { event.stopPropagation(); data.onSelect(); }}>{label}</button>}
    </EdgeLabelRenderer>
  </g>;
}
