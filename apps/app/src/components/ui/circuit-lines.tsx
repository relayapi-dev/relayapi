export function CircuitLines() {
    return (
        <div className="absolute inset-0 -z-10 overflow-hidden pointer-events-none">
            <svg className="absolute w-full h-full" xmlns="http://www.w3.org/2000/svg">
                {/* Top-right area lines */}
                <g className="text-foreground" stroke="currentColor" fill="currentColor" opacity="0.05">
                    {/* Line 1: horizontal with right-angle turn down */}
                    <path d="M 700 60 L 900 60 L 900 180" fill="none" strokeWidth="0.75" />
                    <circle cx="700" cy="60" r="2.5" />
                    <circle cx="900" cy="60" r="2" />
                    <circle cx="900" cy="180" r="2.5" />

                    {/* Line 2: horizontal with turn down-left */}
                    <path d="M 850 120 L 1100 120 L 1100 260" fill="none" strokeWidth="0.75" />
                    <circle cx="850" cy="120" r="2" />
                    <circle cx="1100" cy="120" r="2" />
                    <circle cx="1100" cy="260" r="2.5" />

                    {/* Line 3: vertical with right-angle turn right */}
                    <path d="M 950 30 L 950 150 L 1150 150" fill="none" strokeWidth="0.5" />
                    <circle cx="950" cy="30" r="2" />
                    <circle cx="1150" cy="150" r="2.5" />

                    {/* Line 4: short horizontal stub top-right */}
                    <path d="M 1050 80 L 1200 80" fill="none" strokeWidth="0.75" />
                    <circle cx="1050" cy="80" r="2" />
                    <circle cx="1200" cy="80" r="2.5" />

                    {/* Line 5: right side vertical with turn left */}
                    <path d="M 1180 200 L 1180 320 L 1020 320" fill="none" strokeWidth="0.5" />
                    <circle cx="1180" cy="200" r="2.5" />
                    <circle cx="1180" cy="320" r="2" />
                    <circle cx="1020" cy="320" r="2.5" />

                    {/* Line 6: bottom-left area - horizontal with turn up */}
                    <path d="M 80 450 L 250 450 L 250 350" fill="none" strokeWidth="0.75" />
                    <circle cx="80" cy="450" r="2.5" />
                    <circle cx="250" cy="450" r="2" />
                    <circle cx="250" cy="350" r="2" />

                    {/* Line 7: bottom-left vertical stub */}
                    <path d="M 150 500 L 150 400 L 300 400" fill="none" strokeWidth="0.5" />
                    <circle cx="150" cy="500" r="2" />
                    <circle cx="300" cy="400" r="2.5" />

                    {/* Line 8: top-right diagonal connector */}
                    <path d="M 780 200 L 780 280 L 920 280" fill="none" strokeWidth="0.75" />
                    <circle cx="780" cy="200" r="2" />
                    <circle cx="920" cy="280" r="2.5" />
                </g>
            </svg>
        </div>
    );
}
